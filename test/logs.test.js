const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { parseLog, tailLog } = require('../src/parsers/logs');

const FIX_DIR = path.join(__dirname, 'fixtures', '.voltron', 'logs');

function readFixture(name) {
  return fs.readFileSync(path.join(FIX_DIR, name), 'utf8');
}

test('parseLog: code-analyst log (with STEPs) derives container name + done state', () => {
  const file = 'code-analyst-2026-05-28T17-19-25.log';
  const p = parseLog(readFixture(file), file);
  assert.ok(p, 'should return a payload');
  assert.strictEqual(p.containerName, 'code-analyst-2026-05-28T17-19-25');
  assert.strictEqual(p.nodeId, 'code-analyst-2026-05-28T17-19-25');
  assert.strictEqual(p.agent, 'code-analyst');
  assert.strictEqual(p.exitCode, 0);
  assert.strictEqual(p.state, 'done');
  assert.ok(
    !String(p.latestStep || '').includes('[STEP undefined]'),
    'latestStep must never contain "[STEP undefined]"'
  );
});

test('parseLog: committer log has NO bare STEP/DONE — label derived from status', () => {
  const file = 'committer-2026-05-29T20-18-48-tu28cc.log';
  const p = parseLog(readFixture(file), file);
  assert.ok(p);
  assert.strictEqual(p.containerName, 'committer-2026-05-29T20-18-48-tu28cc');
  assert.strictEqual(p.agent, 'committer');
  assert.strictEqual(p.exitCode, 0);
  assert.strictEqual(p.state, 'done');
  assert.strictEqual(typeof p.latestStep, 'string');
  assert.ok(p.latestStep.length > 0, 'latestStep should be a non-empty derived label');
  assert.ok(!p.latestStep.includes('[STEP undefined]'), 'must not produce "[STEP undefined]"');
});

test('parseLog: tiny postcleanup log with bare [STEP] (no number) preserves the body', () => {
  const file = 'postcleanup-T1-001-023351.log';
  const p = parseLog(readFixture(file), file);
  assert.ok(p);
  assert.strictEqual(typeof p.latestStep, 'string');
  assert.ok(!p.latestStep.includes('[STEP undefined]'), 'never produce "[STEP undefined]"');
  assert.ok(
    p.latestStep.includes('runner: dispatching'),
    'latestStep should preserve STEP body text'
  );
  assert.strictEqual(p.containerName, 'postcleanup-T1-001-023351');
});

test('parseLog: branch-manager log parses exit code 0 -> done state', () => {
  const file = 'branch-manager-2026-06-05T17-08-55-pbzv5o.log';
  const p = parseLog(readFixture(file), file);
  assert.ok(p);
  assert.strictEqual(p.agent, 'branch-manager');
  assert.strictEqual(p.exitCode, 0);
  assert.strictEqual(p.state, 'done');
});

test('parseLog: tolerates CRLF line endings', () => {
  const lf =
    '[entry] 2026-01-01T00:00:00+00:00 host=x\n' +
    '[exec] 2026-01-01T00:00:01+00:00\n' +
    '[STEP 1] hello\n' +
    '[exit] 2026-01-01T00:00:02+00:00 code=0\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const p = parseLog(crlf, 'fake-agent-2026-01-01T00-00-00.log');
  assert.ok(p);
  assert.strictEqual(p.exitCode, 0);
  assert.strictEqual(p.state, 'done');
  assert.strictEqual(p.latestStep, '[STEP 1] hello');
});

test('parseLog: non-zero exit code -> errored state', () => {
  const content = '[entry] t host=x\n[exec] t\n[exit] t code=1\n';
  const p = parseLog(content, 'foo-2026-01-01T00-00-00.log');
  assert.ok(p);
  assert.strictEqual(p.exitCode, 1);
  assert.strictEqual(p.state, 'errored');
});

test('parseLog: bare [STEP] (no number) never yields "[STEP undefined]"', () => {
  const p = parseLog('[STEP] runner: dispatching foo\n', 'bar-2026-01-01T00-00-00.log');
  assert.ok(p);
  assert.strictEqual(p.latestStep, '[STEP] runner: dispatching foo');
  assert.ok(!p.latestStep.includes('[STEP undefined]'));
});

test('parseLog: returns null for an unusable filename', () => {
  assert.strictEqual(parseLog('whatever', ''), null);
  assert.strictEqual(parseLog('whatever', 42), null);
});

test('tailLog: reads only bytes after fromOffset', () => {
  const filePath = path.join(FIX_DIR, 'branch-manager-2026-06-05T17-08-55-pbzv5o.log');
  const size = fs.statSync(filePath).size;

  const first = tailLog(filePath, 0);
  assert.strictEqual(first.newOffset, size);
  assert.ok(first.event, 'reading from 0 should produce a payload');

  const second = tailLog(filePath, size);
  assert.strictEqual(second.newOffset, size);
  assert.strictEqual(second.event, null);

  const third = tailLog(filePath, size + 1000);
  assert.strictEqual(third.event, null);
});
