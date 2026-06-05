const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { parseJournal } = require('../src/parsers/journal');

const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  '.voltron',
  'journal',
  '2026-06-05.md'
);
const FIXTURE_NAME = '2026-06-05.md';
const ALLOWED_KINDS = new Set([
  'session_start',
  'dispatch',
  'task_start',
  'task_complete',
  'validation_pass',
  'validation_fail',
  'handoff',
  'note',
  'session_recap',
]);

function loadFixture() {
  const content = fs.readFileSync(FIXTURE_PATH, 'utf8');
  return parseJournal(content, FIXTURE_NAME);
}

test('parseJournal yields > 0 entries from the real fixture', () => {
  const entries = loadFixture();
  assert.ok(Array.isArray(entries));
  assert.ok(entries.length > 0, 'expected at least one parsed entry');
});

test('every entry has a non-empty string payload.agent', () => {
  const entries = loadFixture();
  for (const entry of entries) {
    assert.strictEqual(typeof entry.payload.agent, 'string');
    assert.ok(entry.payload.agent.length > 0);
  }
});

test('every entry payload.kind is in the allowed set', () => {
  const entries = loadFixture();
  for (const entry of entries) {
    assert.ok(
      ALLOWED_KINDS.has(entry.payload.kind),
      `unexpected kind: ${entry.payload.kind}`
    );
  }
});

test('every entry has payload.date === "2026-06-05"', () => {
  const entries = loadFixture();
  for (const entry of entries) {
    assert.strictEqual(entry.payload.date, '2026-06-05');
  }
});

test('every entry has event === "journal:append"', () => {
  const entries = loadFixture();
  for (const entry of entries) {
    assert.strictEqual(entry.event, 'journal:append');
  }
});

test('every entry payload.time matches /^\\d{2}:\\d{2}$/', () => {
  const entries = loadFixture();
  for (const entry of entries) {
    assert.match(entry.payload.time, /^\d{2}:\d{2}$/);
  }
});

test('filename without a valid YYYY-MM-DD basename returns []', () => {
  const result = parseJournal('**17:03** 🚀 `scrum-master` [note] hi', 'not-a-date.md');
  assert.deepStrictEqual(result, []);
});

test('lines not matching the regex yield [] with a valid filename', () => {
  const result = parseJournal('random garbage\nanother bad line\n', FIXTURE_NAME);
  assert.deepStrictEqual(result, []);
});
