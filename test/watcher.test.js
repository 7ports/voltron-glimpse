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

test('pollTail: tolerates a missing logs dir without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimpse-watcher-nodir-'));
  // No .voltron/logs created on purpose.
  const events = [];
  const w = createWatcher(dir, (e) => events.push(e));
  assert.doesNotThrow(() => w.pollTail());
  assert.strictEqual(events.length, 0);
  return w.close();
});
