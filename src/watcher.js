'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const { tailLog } = require('./parsers/logs');

const DEBOUNCE_MS = 120;

// Logs-only watcher. Watches `.voltron/logs/*.log` under the project root and,
// on each appended chunk, hands the parsed live-state payload to `onLogEvent`
// (the CLI wires that to liveness.applyLogEvent). All routing for progress.json,
// journal/, analyses/, and .beads/ is gone (docs/live-monitor-redesign.md §5.1,
// watcher.js → gut). Offsets are tracked so only new bytes are parsed; historical
// log content is skipped at startup (present-tense rule, §2.5).
function createWatcher(projectRoot, onLogEvent) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('createWatcher: projectRoot (string) is required');
  }
  if (typeof onLogEvent !== 'function') {
    throw new Error('createWatcher: onLogEvent callback is required');
  }

  const logsDir = path.join(projectRoot, '.voltron', 'logs');
  const logOffsets = new Map();
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

  function route(file) {
    const resolved = path.resolve(file);
    const dir = path.dirname(resolved);
    const ext = path.extname(resolved).toLowerCase();
    if (dir === path.resolve(logsDir) && ext === '.log') {
      debounce(resolved, DEBOUNCE_MS, function () {
        handleLog(resolved);
      });
    }
  }

  // Seed offsets to current size so the first post-startup append is tailed
  // from end-of-file — historical log content is not replayed.
  function scanExisting() {
    let entries;
    try {
      entries = fs.readdirSync(logsDir);
    } catch (_e) {
      return; // logs dir may not exist yet — tolerate it
    }
    for (const name of entries) {
      if (path.extname(name).toLowerCase() !== '.log') continue;
      const resolved = path.resolve(path.join(logsDir, name));
      try {
        logOffsets.set(resolved, fs.statSync(resolved).size);
      } catch (_e) {
        /* ignore unreadable entries */
      }
    }
  }

  // `usePolling` (not native fs events) + no `awaitWriteFinish`: container-written
  // logs on WSL2/Windows bind mounts coalesce/miss native events, and
  // awaitWriteFinish defers a continuously-growing log until writes settle. Polling
  // surfaces appends promptly; pollTail() below is the authoritative belt-and-suspenders.
  const watcher = chokidar.watch(logsDir, {
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

  // Poll-driven tail: independent of native fs events. Walks the logs dir, picks up
  // any *.log that appeared after startup (untracked files default to offset 0, so
  // their [entry]/[exec] are read), and for every tracked log whose size grew reads
  // ONLY the appended bytes via handleLog (offset-tracked + idempotent). Reading past
  // EOF is a no-op, so calling this alongside chokidar is safe. The CLI invokes it on
  // the Docker poll cadence so liveness no longer depends on fs-watch events firing.
  function pollTail() {
    let entries;
    try {
      entries = fs.readdirSync(logsDir);
    } catch (_e) {
      return; // logs dir may not exist yet — tolerate it
    }
    for (const name of entries) {
      if (path.extname(name).toLowerCase() !== '.log') continue;
      const resolved = path.resolve(path.join(logsDir, name));
      try {
        handleLog(resolved);
      } catch (_e) {
        /* swallow per-file read/parse errors — observer must never crash */
      }
    }
  }

  function close() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    return watcher.close();
  }

  return { watcher, scanExisting, pollTail, close };
}

module.exports = { createWatcher };
