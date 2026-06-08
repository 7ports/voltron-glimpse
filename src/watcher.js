'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const { parseProgress } = require('./parsers/progress');
const { parseJournal } = require('./parsers/journal');
const { tailLog } = require('./parsers/logs');
const { indexAnalysis } = require('./parsers/analyses');
const { loadBeads } = require('./parsers/beads');

const DEBOUNCE_MS = 120;
const BEADS_DEBOUNCE_MS = 400;

function createWatcher(projectRoot, bus) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new Error('createWatcher: projectRoot (string) is required');
  }
  if (!bus || typeof bus.emit !== 'function') {
    throw new Error('createWatcher: bus with emit() is required');
  }

  const voltronDir = path.join(projectRoot, '.voltron');
  const progressFile = path.join(voltronDir, 'progress.json');
  const journalDir = path.join(voltronDir, 'journal');
  const logsDir = path.join(voltronDir, 'logs');
  const analysesDir = path.join(voltronDir, 'analyses');
  const beadsFile = path.join(projectRoot, '.beads', 'interactions.jsonl');

  const logOffsets = new Map();
  const timers = new Map();

  function emitAll(events) {
    if (!Array.isArray(events)) return;
    for (const evt of events) {
      if (evt && evt.event) bus.emit(evt.event, evt.payload);
    }
  }

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

  function handleProgress() {
    let raw;
    try {
      raw = fs.readFileSync(progressFile, 'utf8');
    } catch (_e) {
      return;
    }
    emitAll(parseProgress(raw));
  }

  function handleJournal(file) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (_e) {
      return;
    }
    emitAll(parseJournal(raw, file));
  }

  function handleLog(file) {
    const from = logOffsets.get(file) || 0;
    const { events, newOffset } = tailLog(file, from);
    logOffsets.set(file, newOffset);
    emitAll(events);
  }

  function handleAnalysis(file) {
    try {
      emitAll([indexAnalysis(file)]);
    } catch (_e) {
      /* ignore */
    }
  }

  function handleBeads() {
    emitAll(loadBeads(projectRoot));
  }

  function route(file) {
    const resolved = path.resolve(file);
    if (resolved === path.resolve(progressFile)) {
      debounce(resolved, DEBOUNCE_MS, handleProgress);
      return;
    }
    if (resolved === path.resolve(beadsFile)) {
      debounce(resolved, BEADS_DEBOUNCE_MS, handleBeads);
      return;
    }
    const dir = path.dirname(resolved);
    const ext = path.extname(resolved).toLowerCase();
    if (dir === path.resolve(journalDir) && ext === '.md') {
      debounce(resolved, DEBOUNCE_MS, function () {
        handleJournal(resolved);
      });
      return;
    }
    if (dir === path.resolve(logsDir) && ext === '.log') {
      debounce(resolved, DEBOUNCE_MS, function () {
        handleLog(resolved);
      });
      return;
    }
    if (dir === path.resolve(analysesDir) && ext === '.md') {
      debounce(resolved, DEBOUNCE_MS, function () {
        handleAnalysis(resolved);
      });
    }
  }

  function scanDir(dir, ext, handler) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (_e) {
      return;
    }
    for (const name of entries) {
      if (path.extname(name).toLowerCase() !== ext) continue;
      handler(path.join(dir, name));
    }
  }

  function scanExisting() {
    if (fs.existsSync(progressFile)) handleProgress();
    scanDir(journalDir, '.md', handleJournal);
    scanDir(logsDir, '.log', handleLog);
    scanDir(analysesDir, '.md', handleAnalysis);
    if (fs.existsSync(beadsFile)) handleBeads();
  }

  const watchTargets = [progressFile, journalDir, logsDir, analysesDir, beadsFile];

  const watcher = chokidar.watch(watchTargets, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });

  watcher.on('add', route);
  watcher.on('change', route);
  watcher.on('error', function () {
    /* tolerate watch errors (missing dirs, EPERM on Windows) */
  });

  function close() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    return watcher.close();
  }

  return { watcher, scanExisting, close };
}

module.exports = { createWatcher };
