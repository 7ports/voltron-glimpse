const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseLatestJournalEntry,
  tailJournal,
  deriveJournalDate,
} = require('../src/parsers/journal');

const FIXTURE = [
  '# Journal 2026-06-10',
  '',
  '**09:01** 🚀 `scrum-master` [session_start] Booting sprint for Voltron Glimpse',
  '**09:05** → `scrum-master` [dispatch] Dispatched fullstack-dev (B1) to scaffold the repo',
  '**09:12** ✅ `scrum-master` [validation_pass] node --test green for parser slice',
].join('\n');

test('parseLatestJournalEntry: returns ONLY the last matching entry', () => {
  const sig = parseLatestJournalEntry(FIXTURE, '/tmp/2026-06-10.md');
  assert.ok(sig, 'a signal is returned');
  assert.strictEqual(sig.kind, 'validation_pass', 'last entry kind wins');
  assert.strictEqual(sig.text, 'node --test green for parser slice');
  assert.strictEqual(sig.time, '09:12');
  assert.strictEqual(sig.agent, 'scrum-master');
  assert.strictEqual(sig.emoji, '✅');
  assert.strictEqual(sig.date, '2026-06-10', 'date derived from filename');
});

test('parseLatestJournalEntry: mid-file entries are ignored (only latest survives)', () => {
  const sig = parseLatestJournalEntry(FIXTURE, '2026-06-10.md');
  assert.notStrictEqual(sig.kind, 'session_start');
  assert.notStrictEqual(sig.kind, 'dispatch');
});

test('parseLatestJournalEntry: a non-matching chunk returns null', () => {
  assert.strictEqual(
    parseLatestJournalEntry('just some prose\nno journal lines here', '2026-06-10.md'),
    null
  );
  assert.strictEqual(parseLatestJournalEntry('', '2026-06-10.md'), null);
});

test('parseLatestJournalEntry: tolerates CRLF and a partial trailing line', () => {
  const crlf =
    '**08:00** 📝 `scrum-master` [note] first note\r\n' +
    '**08:30** → `scrum-master` [dispatch] Dispatched qa-tester to run gates\r\n' +
    '**08:31** 🚀 `scrum-mas';
  const sig = parseLatestJournalEntry(crlf, '2026-06-10.md');
  assert.ok(sig);
  assert.strictEqual(sig.kind, 'dispatch', 'last COMPLETE line wins; partial trailing line skipped');
  assert.strictEqual(sig.text, 'Dispatched qa-tester to run gates');
});

test('tailJournal: reads only bytes after fromOffset and returns the latest signal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimpse-journal-'));
  const file = path.join(dir, '2026-06-10.md');
  fs.writeFileSync(file, '**07:00** 📝 `scrum-master` [note] preexisting line\n');
  const size = fs.statSync(file).size;

  // From end-of-file: nothing new.
  const a = tailJournal(file, size);
  assert.strictEqual(a.signal, null, 'no new bytes => null signal');
  assert.strictEqual(a.newOffset, size);

  // Append one entry; tail from the seeded offset returns exactly that entry.
  fs.appendFileSync(file, '**07:15** → `scrum-master` [dispatch] Dispatched ui-designer\n');
  const b = tailJournal(file, size);
  assert.ok(b.signal, 'appended entry parsed');
  assert.strictEqual(b.signal.kind, 'dispatch');
  assert.strictEqual(b.signal.text, 'Dispatched ui-designer');
  assert.strictEqual(b.newOffset, fs.statSync(file).size);
});

test('tailJournal: missing file returns null without throwing', () => {
  const r = tailJournal(path.join(os.tmpdir(), 'does-not-exist-xyz', '2026-06-10.md'), 0);
  assert.strictEqual(r.signal, null);
});

test('deriveJournalDate: pulls YYYY-MM-DD from filename, null otherwise', () => {
  assert.strictEqual(deriveJournalDate('/a/b/2026-06-10.md'), '2026-06-10');
  assert.strictEqual(deriveJournalDate('notes.md'), null);
});
