const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveState } = require('../src/model/statusMachine');

test('errored (progress=failed) beats done (log=done)', () => {
  assert.equal(
    deriveState({ progressStatus: 'failed', logState: 'done' }),
    'errored'
  );
});

test('log working beats progress queued', () => {
  assert.equal(
    deriveState({ progressStatus: 'queued', logState: 'working' }),
    'working'
  );
});

test('log dispatching beats progress queued', () => {
  assert.equal(
    deriveState({ progressStatus: 'queued', logState: 'dispatching' }),
    'dispatching'
  );
});

test('progress blocked beats log working', () => {
  assert.equal(
    deriveState({ progressStatus: 'blocked', logState: 'working' }),
    'blocked'
  );
});

test('non-zero exit code yields errored even with no log state', () => {
  assert.equal(deriveState({ logState: null, exitCode: 1 }), 'errored');
});

test('exit code 0 yields done', () => {
  assert.equal(deriveState({ logState: null, exitCode: 0 }), 'done');
});

test('no signals at all -> queued (default)', () => {
  assert.equal(deriveState({}), 'queued');
});

test('undefined input -> queued (default)', () => {
  assert.equal(deriveState(undefined), 'queued');
});

test('progress queued, no log -> queued', () => {
  assert.equal(deriveState({ progressStatus: 'queued', logState: null }), 'queued');
});

test('progress completed, no log -> done', () => {
  assert.equal(deriveState({ progressStatus: 'completed', logState: null }), 'done');
});

test('log working overrides progress completed (stale progress)', () => {
  assert.equal(
    deriveState({ progressStatus: 'completed', logState: 'working' }),
    'working'
  );
});

test('log errored beats progress queued', () => {
  assert.equal(
    deriveState({ progressStatus: 'queued', logState: 'errored' }),
    'errored'
  );
});
