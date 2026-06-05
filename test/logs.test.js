const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { parseLog, tailLog } = require('../src/parsers/logs');
const { EVENTS } = require('../src/eventBus');

const FIX_DIR = path.join(__dirname, 'fixtures', '.voltron', 'logs');

function readFixture(name) {
  return fs.readFileSync(path.join(FIX_DIR, name), 'utf8');
}

test('parseLog: code-analyst log (with STEPs) derives container name + done state', () => {
  const file = 'code-analyst-2026-05-28T17-19-25.log';
  const events = parseLog(readFixture(file), file);
  assert.ok(events.length > 0, 'should emit events');
  const agentEvent = events.find((e) => e.event === EVENTS.AGENT_UPDATE);
  assert.ok(agentEvent, 'should emit AGENT_UPDATE');
  assert.strictEqual(agentEvent.payload.containerName, 'code-analyst-2026-05-28T17-19-25');
  assert.strictEqual(agentEvent.payload.nodeId, 'code-analyst-2026-05-28T17-19-25');
  assert.strictEqual(agentEvent.payload.agent, 'code-analyst');
  assert.strictEqual(agentEvent.payload.exitCode, 0);
  assert.strictEqual(agentEvent.payload.state, 'done');
  assert.ok(
    !String(agentEvent.payload.latestStep || '').includes('[STEP undefined]'),
    'latestStep must never contain "[STEP undefined]"'
  );
});

test('parseLog: committer log has NO bare STEP/DONE — label derived from status', () => {
  const file = 'committer-2026-05-29T20-18-48-tu28cc.log';
  const events = parseLog(readFixture(file), file);
  const agentEvent = events.find((e) => e.event === EVENTS.AGENT_UPDATE);
  assert.ok(agentEvent, 'should emit AGENT_UPDATE');
  assert.strictEqual(agentEvent.payload.containerName, 'committer-2026-05-29T20-18-48-tu28cc');
  assert.strictEqual(agentEvent.payload.agent, 'committer');
  assert.strictEqual(agentEvent.payload.exitCode, 0);
  assert.strictEqual(agentEvent.payload.state, 'done');
  assert.strictEqual(typeof agentEvent.payload.latestStep, 'string');
  assert.ok(agentEvent.payload.latestStep.length > 0, 'latestStep should be a non-empty derived label');
  assert.ok(
    !agentEvent.payload.latestStep.includes('[STEP undefined]'),
    'must not produce "[STEP undefined]"'
  );
});

test('parseLog: tiny postcleanup log with bare [STEP] (no number) yields LOG_UPDATE', () => {
  const file = 'postcleanup-T1-001-023351.log';
  const events = parseLog(readFixture(file), file);
  const logEvent = events.find((e) => e.event === EVENTS.LOG_UPDATE);
  assert.ok(logEvent, 'should emit LOG_UPDATE even without entry/exec/exit');
  assert.strictEqual(typeof logEvent.payload.latestStep, 'string');
  assert.ok(
    !logEvent.payload.latestStep.includes('[STEP undefined]'),
    'never produce "[STEP undefined]"'
  );
  assert.ok(
    logEvent.payload.latestStep.includes('runner: dispatching'),
    'latestStep should preserve STEP body text'
  );
  assert.strictEqual(logEvent.payload.containerName, 'postcleanup-T1-001-023351');
});

test('parseLog: branch-manager log parses exit code 0 -> done state', () => {
  const file = 'branch-manager-2026-06-05T17-08-55-pbzv5o.log';
  const events = parseLog(readFixture(file), file);
  const agentEvent = events.find((e) => e.event === EVENTS.AGENT_UPDATE);
  assert.ok(agentEvent);
  assert.strictEqual(agentEvent.payload.agent, 'branch-manager');
  assert.strictEqual(agentEvent.payload.exitCode, 0);
  assert.strictEqual(agentEvent.payload.state, 'done');
});

test('parseLog: tolerates CRLF line endings', () => {
  const lf =
    '[entry] 2026-01-01T00:00:00+00:00 host=x\n' +
    '[exec] 2026-01-01T00:00:01+00:00\n' +
    '[STEP 1] hello\n' +
    '[exit] 2026-01-01T00:00:02+00:00 code=0\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const out = parseLog(crlf, 'fake-agent-2026-01-01T00-00-00.log');
  const agentEvent = out.find((e) => e.event === EVENTS.AGENT_UPDATE);
  assert.ok(agentEvent);
  assert.strictEqual(agentEvent.payload.exitCode, 0);
  assert.strictEqual(agentEvent.payload.state, 'done');
  assert.strictEqual(agentEvent.payload.latestStep, '[STEP 1] hello');
});

test('parseLog: non-zero exit code -> errored state', () => {
  const content = '[entry] t host=x\n[exec] t\n[exit] t code=1\n';
  const out = parseLog(content, 'foo-2026-01-01T00-00-00.log');
  const agentEvent = out.find((e) => e.event === EVENTS.AGENT_UPDATE);
  assert.ok(agentEvent);
  assert.strictEqual(agentEvent.payload.exitCode, 1);
  assert.strictEqual(agentEvent.payload.state, 'errored');
});

test('parseLog: bare [STEP] (no number) never yields "[STEP undefined]"', () => {
  const content = '[STEP] runner: dispatching foo\n';
  const out = parseLog(content, 'bar-2026-01-01T00-00-00.log');
  const logEvent = out.find((e) => e.event === EVENTS.LOG_UPDATE);
  assert.ok(logEvent);
  assert.strictEqual(logEvent.payload.latestStep, '[STEP] runner: dispatching foo');
  assert.ok(!logEvent.payload.latestStep.includes('[STEP undefined]'));
});

test('tailLog: reads only bytes after fromOffset', () => {
  const filePath = path.join(FIX_DIR, 'branch-manager-2026-06-05T17-08-55-pbzv5o.log');
  const size = fs.statSync(filePath).size;

  const first = tailLog(filePath, 0);
  assert.strictEqual(first.newOffset, size);
  assert.ok(first.events.length > 0, 'reading from 0 should produce events');

  const second = tailLog(filePath, size);
  assert.strictEqual(second.newOffset, size);
  assert.strictEqual(second.events.length, 0);

  const third = tailLog(filePath, size + 1000);
  assert.strictEqual(third.events.length, 0);
});
