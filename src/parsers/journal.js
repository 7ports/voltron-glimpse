const path = require('node:path');
const { EVENTS } = require('../eventBus');

const LINE_RE = /^\*\*(\d{2}:\d{2})\*\*\s+(\S+)\s+`([^`]+)`\s+\[(\w+)\]\s+(.*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseJournal(content, filename) {
  if (typeof content !== 'string' || typeof filename !== 'string') return [];
  const date = path.basename(filename, '.md');
  if (!DATE_RE.test(date)) return [];
  const out = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, time, emoji, agent, kind, text] = m;
    out.push({
      event: EVENTS.JOURNAL_APPEND,
      payload: { time, date, emoji, agent, kind, text },
    });
  }
  return out;
}

module.exports = { parseJournal };
