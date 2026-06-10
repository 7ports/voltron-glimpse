'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const { tailLog } = require('./parsers/logs');
const { tailJournal } = require('./parsers/journal');

const DEBOUNCE_MS = 120;

// Logs + journal watcher. Watches `.voltron/logs/*.log` and `.voltron/journal/*.md`
// under the project root. On each appended log chunk it hands the parsed live-state
// payload to `onLogEvent`; on each appended journal chunk it hands the latest
// JournalSignal to `onJournalEvent` (the CLI wires these to liveness). Offsets are
// tracked so only new bytes are parsed; historical content is skipped at startup
// (present-tense rule, §2.5). Native fs events are unreliable on WSL2/Windows bind
// mounts, so pollTail() re-tails BOTH logs and the journal on the poll cadence as the
// authoritative belt-and-suspenders. Read-only: only reads/stats/tails — never writes.
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

  const logsDir = path.join(projectRoot, '.voltron', 'logs');
  const journalDir = path.join(projectRoot, '.voltron', 'journal');
  const logOffsets = new Map();
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

  function handleLog(file) {
    const from = logOffsets.get(file) || 0;
    const { event, newOffset } = tailLog(file, from);
    logOffsets.set(file, newOffset);
    if (event) onLogEvent(event);
  }

  function handleJournal(file) {
    const from = journalOffsets.get(file) || 0;
    const { signal, newOffset } = tailJournal(file, from);
    journalOffsets.set(file, newOffset);
    if (signal) emitJournal(signal);
  }

  function route(file) {
    const resolved = path.resolve(file);
    const dir = path.dirname(resolved);
    const ext = path.extname(resolved).toLowerCase();
    if (dir === path.resolve(logsDir) && ext === '.log') {
      debounce(resolved, DEBOUNCE_MS, function () {
        handleLog(resolved);
      });
    } else if (dir === path.resolve(journalDir) && ext === '.md') {
      debounce(resolved, DEBOUNCE_MS, function () {
        handleJournal(resolved);
      });
    }
  }

  // Seed offsets to current size so the first post-startup append is tailed from
  // end-of-file — historical log/journal content is not replayed (present-tense rule).
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
    seedDir(logsDir, '.log', logOffsets);
    seedDir(journalDir, '.md', journalOffsets);
  }

  // `usePolling` (not native fs events) + no `awaitWriteFinish`: container-written
  // logs and host-written journal entries on WSL2/Windows bind mounts coalesce/miss
  // native events, and awaitWriteFinish defers a continuously-growing file until writes
  // settle. Polling surfaces appends promptly; pollTail() below is the authoritative
  // belt-and-suspenders.
  const watcher = chokidar.watch([logsDir, journalDir], {
    ignoreInitial: true,
    persistent: true,
    usePolling: true,
    interval: 500,
  });

  watcher.on('add', route);
  watcher.on('change', route);
  watcher.on('error', function () {
    /* tolerate watch errors (missing dir, EPERM on Windows) */
  });

  // Poll-driven tail: independent of native fs events. Walks the logs and journal dirs,
  // picks up any *.log/*.md that appeared after startup (untracked files default to
  // offset 0, so their first content is read), and for every tracked file whose size
  // grew reads ONLY the appended bytes (offset-tracked + idempotent). Reading past EOF is
  // a no-op, so calling this alongside chokidar is safe. The CLI invokes it on the Docker
  // poll cadence so both container liveness and hub liveness advance on that cadence.
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
    pollDir(logsDir, '.log', handleLog);
    pollDir(journalDir, '.md', handleJournal);
  }

  function close() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    return watcher.close();
  }

  return { watcher, scanExisting, pollTail, close };
}

module.exports = { createWatcher };
