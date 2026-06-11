'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Journal line format (docs/implementation-plan.md §2):
//   **HH:MM** <emoji> `agent_name` [kind] free text…
// Groups: 1=time, 2=emoji, 3=agent, 4=kind, 5=text.
const RE_JOURNAL = /^\*\*(\d{2}:\d{2})\*\*\s+(\S+)\s+`([^`]+)`\s+\[(\w+)\]\s+(.*)$/;

const DATE_RE = /(\d{4}-\d{2}-\d{2})\.md$/i;

// Derive the UTC day (YYYY-MM-DD) from a journal filename like `2026-06-10.md`.
// Returns null when the filename carries no recognizable date.
function deriveJournalDate(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const m = DATE_RE.exec(path.basename(filePath));
  return m ? m[1] : null;
}

// Scan `text` for journal lines and return ONLY the latest (last) matching entry
// as a JournalSignal, or null when nothing matches. Tolerates CRLF and a
// partial/trailing incomplete final line (a non-matching line is simply skipped).
// JournalSignal shape: { time, date, kind, agent, text, emoji }.
function parseLatestJournalEntry(text, filePath) {
  if (typeof text !== 'string') return null;
  const date = deriveJournalDate(filePath);
  const lines = text.split(/\r?\n/);

  let signal = null;
  for (const line of lines) {
    if (!line || line.charCodeAt(0) !== 42) continue; // fast-skip: a journal line must start with '*'
    const m = RE_JOURNAL.exec(line);
    if (!m) continue;
    signal = {
      time: m[1],
      date,
      kind: m[4],
      agent: m[3],
      text: m[5].trim(),
      emoji: m[2],
    };
  }
  return signal;
}

// Read only the bytes appended since `fromOffset`, parse them, and return the
// latest JournalSignal in that new chunk (or null) plus the new offset. Parallels
// `tailLog` in src/parsers/logs.js — read-only (stat + read from offset), never writes.
function tailJournal(filePath, fromOffset = 0) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { signal: null, newOffset: Number(fromOffset) || 0 };
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_err) {
    return { signal: null, newOffset: Number(fromOffset) || 0 };
  }
  const size = stat.size;
  const start = Math.max(0, Number(fromOffset) || 0);
  if (start >= size) {
    return { signal: null, newOffset: size };
  }
  const length = size - start;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  const signal = parseLatestJournalEntry(buf.toString('utf8'), filePath);
  return { signal, newOffset: size };
}

module.exports = { parseLatestJournalEntry, tailJournal, deriveJournalDate };
