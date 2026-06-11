const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveState, STATES } = require('../src/model/statusMachine');

test('exposes exactly the four live states', () => {
  assert.deepEqual(Object.values(STATES).sort(), [
    'dispatching',
    'exiting:done',
    'exiting:errored',
    'working',
  ]);
});

test('no signals yet -> dispatching (container up, no [exec])', () => {
  assert.equal(deriveState({}), 'dispatching');
});

test('undefined input -> dispatching (default)', () => {
  assert.equal(deriveState(undefined), 'dispatching');
});

test('logState working -> working', () => {
  assert.equal(deriveState({ logState: 'working' }), 'working');
});

test('hasExec true -> working', () => {
  assert.equal(deriveState({ hasExec: true }), 'working');
});

test('a [STEP] label implies working even without an explicit logState', () => {
  assert.equal(deriveState({ latestStep: '[STEP 2] doing x' }), 'working');
});

test('exit code 0 -> exiting:done', () => {
  assert.equal(deriveState({ logState: 'working', exitCode: 0 }), 'exiting:done');
});

test('non-zero exit code -> exiting:errored (overrides working)', () => {
  assert.equal(deriveState({ logState: 'working', exitCode: 2 }), 'exiting:errored');
});

test('logState done -> exiting:done', () => {
  assert.equal(deriveState({ logState: 'done' }), 'exiting:done');
});

test('logState errored -> exiting:errored', () => {
  assert.equal(deriveState({ logState: 'errored' }), 'exiting:errored');
});

test('exit code wins over a working step label', () => {
  assert.equal(
    deriveState({ logState: 'working', latestStep: '[STEP 9] x', exitCode: 1 }),
    'exiting:errored'
  );
});
