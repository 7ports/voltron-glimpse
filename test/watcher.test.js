const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWatcher } = require('../src/watcher');

function mkTmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimpse-watcher-'));
  fs.mkdirSync(path.join(dir, '.voltron', 'logs'), { recursive: true });
  return dir;
}

test('pollTail: tails appended bytes exactly once (offset advances, no re-process)', async () => {
  const root = mkTmpRoot();
  const logsDir = path.join(root, '.voltron', 'logs');
  const logFile = path.join(logsDir, 'fullstack-dev-2026-06-10T10-00-00.log');

  const events = [];
  const w = createWatcher(root, (e) => events.push(e));

  // A log file appears AFTER startup with just [entry]. pollTail must pick it up.
  fs.writeFileSync(logFile, '[entry] fullstack-dev-2026-06-10T10-00-00\n');
  w.pollTail();
  assert.strictEqual(events.length, 1, 'first poll handles the newly-appeared file once');
  assert.strictEqual(events[0].agent, 'fullstack-dev');
  assert.strictEqual(events[0].state, 'dispatching', '[entry] => dispatching');

  // No growth between polls => no new event (idempotent read past EOF).
  w.pollTail();
  assert.strictEqual(events.length, 1, 'no growth means no re-processing of old bytes');

  // Append [exec] + a STEP mid-run.
  fs.appendFileSync(
    logFile,
    '[exec] fullstack-dev-2026-06-10T10-00-00\n[STEP 1] reading files\n'
  );
  w.pollTail();
  assert.strictEqual(events.length, 2, 'next poll handles only the appended bytes, once');
  assert.strictEqual(events[1].state, 'working', '[exec] => working');
  assert.strictEqual(events[1].latestStep, '[STEP 1] reading files');

  // Still idempotent after the append is consumed.
  w.pollTail();
  assert.strictEqual(events.length, 2, 'no further events once appended bytes are consumed');

  await w.close();
});

test('syncLogRoots: a FOREIGN pod root is tailed from offset 0 and routes into the same sink', async () => {
  const self = mkTmpRoot();
  const foreign = mkTmpRoot();
  const foreignLogsDir = path.join(foreign, '.voltron', 'logs');
  const foreignLog = path.join(foreignLogsDir, 'committer-2026-06-10T11-00-00.log');

  // The foreign container is already running, so its log already has lifecycle
  // lines BEFORE we begin watching — these must be read (catch-up), not skipped.
  fs.writeFileSync(
    foreignLog,
    '[entry] committer-2026-06-10T11-00-00\n[exec] committer-2026-06-10T11-00-00\n[STEP 1] staging\n'
  );

  const events = [];
  const w = createWatcher(self, (e) => events.push(e));
  w.scanExisting(); // seeds ONLY the self root (foreign must not be seeded)

  // Self root has no logs -> nothing yet.
  w.pollTail();
  assert.strictEqual(events.length, 0, 'self root empty, no events');

  // Foreign pod appears in scope.
  w.syncLogRoots([{ root: foreign, podKey: 'foreign', podLabel: 'foreign' }]);
  w.pollTail();
  assert.strictEqual(events.length, 1, 'foreign log read from offset 0 in one consolidated event');
  assert.strictEqual(events[0].agent, 'committer');
  assert.strictEqual(events[0].state, 'working', '[exec] in the existing foreign log => working');
  assert.strictEqual(events[0].latestStep, '[STEP 1] staging');

  // Idempotent: no growth => no re-processing.
  w.pollTail();
  assert.strictEqual(events.length, 1);

  // Append more to the foreign log -> only the new bytes are tailed.
  fs.appendFileSync(foreignLog, '[exit] committer-2026-06-10T11-00-00 code=0\n');
  w.pollTail();
  assert.strictEqual(events.length, 2, 'foreign append tailed once');
  assert.strictEqual(events[1].state, 'done');

  // Pod leaves scope -> its root is dropped; further appends are not read.
  w.syncLogRoots([]);
  fs.appendFileSync(foreignLog, '[STEP 2] ghost\n');
  w.pollTail();
  assert.strictEqual(events.length, 2, 'dropped foreign root is no longer tailed');

  await w.close();
});

test('syncLogRoots: the self/pinned root is never dropped even when sync excludes it', async () => {
  const self = mkTmpRoot();
  const logFile = path.join(self, '.voltron', 'logs', 'fullstack-dev-2026-06-10T12-00-00.log');

  const events = [];
  const w = createWatcher(self, (e) => events.push(e));
  w.scanExisting();

  // Sync with an empty list — self must stay pinned.
  w.syncLogRoots([]);
  fs.writeFileSync(logFile, '[entry] fullstack-dev-2026-06-10T12-00-00\n');
  w.pollTail();
  assert.strictEqual(events.length, 1, 'self root still tailed after an empty sync');
  assert.strictEqual(events[0].state, 'dispatching');

  await w.close();
});

test('pollTail: tolerates a missing logs dir without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimpse-watcher-nodir-'));
  // No .voltron/logs created on purpose.
  const events = [];
  const w = createWatcher(dir, (e) => events.push(e));
  assert.doesNotThrow(() => w.pollTail());
  assert.strictEqual(events.length, 0);
  return w.close();
});

test('pollTail: journal — seeded offset skips history; one append => one onJournalEvent', async () => {
  const root = mkTmpRoot();
  const journalDir = path.join(root, '.voltron', 'journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const journalFile = path.join(journalDir, '2026-06-10.md');

  // Pre-existing history written BEFORE startup must not be replayed.
  fs.writeFileSync(
    journalFile,
    '**09:00** 🚀 `scrum-master` [session_start] booted\n' +
      '**09:01** 📝 `scrum-master` [note] reading backlog\n'
  );

  const logEvents = [];
  const journalSignals = [];
  const w = createWatcher(
    root,
    (e) => logEvents.push(e),
    (s) => journalSignals.push(s)
  );

  // Seed offsets to current size (present-tense rule) — history is skipped.
  w.scanExisting();
  w.pollTail();
  assert.strictEqual(journalSignals.length, 0, 'seeded history is not replayed');

  // Append exactly one new entry.
  fs.appendFileSync(
    journalFile,
    '**09:05** → `scrum-master` [dispatch] Dispatched fullstack-dev (B2)\n'
  );
  w.pollTail();
  assert.strictEqual(journalSignals.length, 1, 'one append => exactly one journal event');
  assert.strictEqual(journalSignals[0].kind, 'dispatch');
  assert.strictEqual(journalSignals[0].text, 'Dispatched fullstack-dev (B2)');
  assert.strictEqual(journalSignals[0].agent, 'scrum-master');

  // Idempotent: no growth => no further events.
  w.pollTail();
  assert.strictEqual(journalSignals.length, 1, 'no growth means no re-processing');

  await w.close();
});
