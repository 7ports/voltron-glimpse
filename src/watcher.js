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

  const watcher = chokidar.watch(logsDir, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });

  watcher.on('add', route);
  watcher.on('change', route);
  watcher.on('error', function () {
    /* tolerate watch errors (missing dir, EPERM on Windows) */
  });

  function close() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    return watcher.close();
  }

  return { watcher, scanExisting, close };
}

module.exports = { createWatcher };
