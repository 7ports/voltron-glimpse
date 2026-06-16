'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const { tailLog } = require('./parsers/logs');
const { tailJournal } = require('./parsers/journal');

const DEBOUNCE_MS = 120;

// Logs + journal watcher. The JOURNAL is single-root (the self pod's
// `.voltron/journal/*.md` — it drives the scrum-master hub). LOGS are MULTI-ROOT:
// Docker membership is host-wide, but each pod writes its `.voltron/logs/*.log`
// under ITS OWN project dir, so to enrich foreign-pod containers
// ([exec]/[STEP]/[exit] → working/steps/exit) we must tail every in-scope pod's
// log dir, not just the launch root's. The self pod's log root is pinned (always
// watched); foreign roots are added/removed via syncLogRoots() as pods appear and
// leave the live set. Every pod's log events flow into the SAME onLogEvent sink
// (nodeIds are globally unique, so the reconciler needs no per-pod awareness).
//
// Offsets are tracked per file so only new bytes are parsed. The self log root and
// the journal are seeded to EOF at scanExisting() (present-tense rule §2.5 — the
// launch pod's history is not replayed). Foreign roots are deliberately NOT
// seeded: a foreign pod is discovered while already running, so its current log is
// read from offset 0 to catch the container up to its present state. Native fs
// events are unreliable on WSL2/Windows bind mounts, so pollTail() re-tails every
// root + the journal on the poll cadence as the authoritative belt-and-suspenders.
// Read-only: only reads/stats/tails — never writes.
function createWatcher(projectRoot, onLogEvent, onJournalEvent) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('createWatcher: projectRoot (string) is required');
  }
  if (typeof onLogEvent !== 'function') {
    throw new Error('createWatcher: onLogEvent callback is required');
  }
  // onJournalEvent is optional — the hub-liveness branch is additive. A no-op default
  // keeps existing two-arg callers (and tests) working unchanged.
  const emitJournal = typeof onJournalEvent === 'function' ? onJournalEvent : function () {};

  const journalDir = path.join(projectRoot, '.voltron', 'journal');
  const journalOffsets = new Map();
  const timers = new Map();

  function debounce(key, ms, fn) {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      timers.delete(key);
      try {
        fn();
      } catch (_e) {
        /* swallow parse/read errors — observer must never crash */
      }
    }, ms);
    if (typeof t.unref === 'function') t.unref();
    timers.set(key, t);
  }

  // --- Multi-root log watching -------------------------------------------
  // logsDir (resolved) -> { dir, watcher, offsets, pinned, podKey, podLabel }
  const logRoots = new Map();

  // Tail one log file for an entry, resetting the offset on ROTATION (the path
  // now points at a different inode — old file renamed away, fresh file created)
  // so the new file is read from the start instead of inheriting the stale
  // offset. Truncation-in-place (same inode, smaller size) is handled downstream
  // inside tailLog. `entry` carries both the offset and inode maps.
  function handleLogFile(file, entry) {
    const offsets = entry.offsets;
    const inodes = entry.inodes;
    let ino = null;
    try {
      ino = fs.statSync(file).ino;
    } catch (_e) {
      return; // file vanished between readdir and stat — skip this tick
    }
    const prevIno = inodes.get(file);
    let from = offsets.get(file) || 0;
    if (prevIno !== undefined && ino !== prevIno) {
      // Rotation detected: the inode changed under a stable path. The tracked
      // offset belongs to the now-rotated-away file; read the new file from 0.
      from = 0;
    }
    inodes.set(file, ino);
    const { event, newOffset } = tailLog(file, from);
    offsets.set(file, newOffset);
    if (event) onLogEvent(event);
  }

  function makeChokidar(dir) {
    // `usePolling` (not native fs events) + no `awaitWriteFinish`: container-written
    // logs on WSL2/Windows bind mounts coalesce/miss native events, and
    // awaitWriteFinish defers a continuously-growing file until writes settle.
    // Polling surfaces appends promptly; pollTail() is the authoritative backup.
    const w = chokidar.watch(dir, {
      ignoreInitial: true,
      persistent: true,
      usePolling: true,
      interval: 500,
    });
    w.on('error', function () {
      /* tolerate watch errors (missing dir, EPERM on Windows) */
    });
    return w;
  }

  // Add a log root if not already present. `pinned` roots (the self pod) are never
  // removed by syncLogRoots. Foreign roots are NOT seeded so their current content
  // is read from offset 0 (catch a live foreign container up to its present state).
  function ensureLogRoot(rootDir, meta, pinned) {
    if (!rootDir || typeof rootDir !== 'string') return;
    const logsDir = path.resolve(path.join(rootDir, '.voltron', 'logs'));
    const existing = logRoots.get(logsDir);
    if (existing) {
      if (meta) {
        if (meta.podKey != null) existing.podKey = meta.podKey;
        if (meta.podLabel != null) existing.podLabel = meta.podLabel;
      }
      if (pinned) existing.pinned = true;
      return;
    }
    const offsets = new Map();
    const watcher = makeChokidar(logsDir);
    const entry = {
      dir: logsDir,
      watcher,
      offsets,
      // inode per file alongside the offset — a changed inode under a stable
      // path means rotation, which resets the offset (see handleLogFile).
      inodes: new Map(),
      pinned: !!pinned,
      podKey: meta ? meta.podKey : null,
      podLabel: meta ? meta.podLabel : null,
    };
    watcher.on('add', function (f) {
      routeLog(entry, f);
    });
    watcher.on('change', function (f) {
      routeLog(entry, f);
    });
    logRoots.set(logsDir, entry);
  }

  function removeLogRoot(logsDir) {
    const entry = logRoots.get(logsDir);
    if (!entry || entry.pinned) return;
    logRoots.delete(logsDir);
    try {
      entry.watcher.close();
    } catch (_e) {
      /* ignore close errors */
    }
  }

  // Reconcile the watched foreign log roots to exactly the supplied in-scope pod
  // roots (the self/pinned root is always kept). `roots` is an array of
  // { root, podKey, podLabel } where `root` is a HOST-READABLE project dir.
  function syncLogRoots(roots) {
    const want = new Map(); // resolved logsDir -> { root, podKey, podLabel }
    for (const r of Array.isArray(roots) ? roots : []) {
      if (!r || !r.root || typeof r.root !== 'string') continue;
      const logsDir = path.resolve(path.join(r.root, '.voltron', 'logs'));
      want.set(logsDir, r);
    }
    for (const r of want.values()) {
      // ensureLogRoot is idempotent: adds a watch+offset-tail for a new root, or
      // just refreshes podKey/podLabel metadata for one already watched.
      ensureLogRoot(r.root, { podKey: r.podKey, podLabel: r.podLabel }, false);
    }
    for (const logsDir of Array.from(logRoots.keys())) {
      const entry = logRoots.get(logsDir);
      if (entry.pinned) continue;
      if (!want.has(logsDir)) removeLogRoot(logsDir);
    }
  }

  // --- Routing -----------------------------------------------------------
  function routeLog(entry, file) {
    const resolved = path.resolve(file);
    if (path.dirname(resolved) !== entry.dir) return;
    if (path.extname(resolved).toLowerCase() !== '.log') return;
    debounce(resolved, DEBOUNCE_MS, function () {
      handleLogFile(resolved, entry);
    });
  }

  function handleJournal(file) {
    const from = journalOffsets.get(file) || 0;
    const { signal, newOffset } = tailJournal(file, from);
    journalOffsets.set(file, newOffset);
    if (signal) emitJournal(signal);
  }

  const journalWatcher = makeChokidar(journalDir);
  journalWatcher.on('add', routeJournal);
  journalWatcher.on('change', routeJournal);

  function routeJournal(file) {
    const resolved = path.resolve(file);
    if (path.dirname(resolved) !== path.resolve(journalDir)) return;
    if (path.extname(resolved).toLowerCase() !== '.md') return;
    debounce(resolved, DEBOUNCE_MS, function () {
      handleJournal(resolved);
    });
  }

  // Pin the self pod's log root from the start so single-pod behavior is identical
  // to before (its dir is always watched, even with zero foreign pods in scope).
  ensureLogRoot(projectRoot, null, true);

  // Seed offsets to current size so the first post-startup append is tailed from
  // end-of-file — historical content is not replayed (present-tense rule). Applies
  // ONLY to the self/pinned log root + the journal; foreign roots intentionally
  // read from 0 (see header note).
  function seedDir(dir, ext, offsets) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (_e) {
      return; // dir may not exist yet — tolerate it
    }
    for (const name of entries) {
      if (path.extname(name).toLowerCase() !== ext) continue;
      const resolved = path.resolve(path.join(dir, name));
      try {
        offsets.set(resolved, fs.statSync(resolved).size);
      } catch (_e) {
        /* ignore unreadable entries */
      }
    }
  }

  function scanExisting() {
    for (const entry of logRoots.values()) {
      if (entry.pinned) seedDir(entry.dir, '.log', entry.offsets);
    }
    seedDir(journalDir, '.md', journalOffsets);
  }

  // Poll-driven tail: independent of native fs events. Walks every watched log root
  // (self + foreign) and the journal, picks up any *.log/*.md that appeared after
  // startup (untracked files default to offset 0, so their first content is read),
  // and for every tracked file whose size grew reads ONLY the appended bytes
  // (offset-tracked + idempotent). Reading past EOF is a no-op, so running this
  // alongside chokidar is safe. The CLI invokes it on the Docker poll cadence.
  function pollDir(dir, ext, handle) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (_e) {
      return; // dir may not exist yet — tolerate it
    }
    for (const name of entries) {
      if (path.extname(name).toLowerCase() !== ext) continue;
      const resolved = path.resolve(path.join(dir, name));
      try {
        handle(resolved);
      } catch (_e) {
        /* swallow per-file read/parse errors — observer must never crash */
      }
    }
  }

  function pollTail() {
    for (const entry of logRoots.values()) {
      pollDir(entry.dir, '.log', function (file) {
        handleLogFile(file, entry);
      });
    }
    pollDir(journalDir, '.md', handleJournal);
  }

  function close() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    const closing = [];
    for (const entry of logRoots.values()) {
      try {
        closing.push(entry.watcher.close());
      } catch (_e) {
        /* ignore */
      }
    }
    logRoots.clear();
    try {
      closing.push(journalWatcher.close());
    } catch (_e) {
      /* ignore */
    }
    return Promise.all(closing);
  }

  // `watcher` retained for back-compat: the self pod's log chokidar instance.
  const selfEntry = logRoots.get(path.resolve(path.join(projectRoot, '.voltron', 'logs')));
  return {
    watcher: selfEntry ? selfEntry.watcher : journalWatcher,
    scanExisting,
    pollTail,
    syncLogRoots,
    close,
  };
}

module.exports = { createWatcher };
