const fs = require('fs');
const path = require('path');
const { EVENTS } = require('../eventBus');

const TIMESTAMP_LEN = 19;
const HEAD_BUFFER_BYTES = 4096;

function parseNameParts(basename) {
  if (basename.length < TIMESTAMP_LEN + 1 || basename[TIMESTAMP_LEN] !== '-') {
    return { timestamp: '', topic: '' };
  }
  const timestamp = basename.slice(0, TIMESTAMP_LEN);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(timestamp)) {
    return { timestamp: '', topic: '' };
  }
  const topic = basename.slice(TIMESTAMP_LEN + 1);
  return { timestamp, topic };
}

function readHeadTitle(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HEAD_BUFFER_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, HEAD_BUFFER_BYTES, 0);
    const text = buf.slice(0, bytesRead).toString('utf8');
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
      if (m) return m[1];
    }
    return '';
  } catch (err) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

function indexAnalysis(filePath) {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const { timestamp, topic } = parseNameParts(base);
  const title = readHeadTitle(filePath);
  return {
    event: EVENTS.ANALYSIS_ADD,
    payload: {
      id: base,
      topic,
      timestamp,
      path: filePath,
      title,
    },
  };
}

function readAnalysis(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

module.exports = { indexAnalysis, readAnalysis };
