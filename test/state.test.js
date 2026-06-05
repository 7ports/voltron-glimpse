const test = require('node:test');
const assert = require('node:assert');
const { StateModel } = require('../src/state');
const { EVENTS } = require('../src/eventBus');

test('StateModel constructor initializes empty collections', () => {
  const s = new StateModel();
  assert.deepStrictEqual(s.agents, {});
  assert.deepStrictEqual(s.edges, []);
  assert.deepStrictEqual(s.phases, {});
  assert.deepStrictEqual(s.journal, []);
  assert.deepStrictEqual(s.analyses, []);
  assert.deepStrictEqual(s.counts, {});
});

test('applyEvent AGENT_UPDATE adds an agent and returns a patch', () => {
  const s = new StateModel();
  const patch = s.applyEvent(EVENTS.AGENT_UPDATE, { id: 'a1', name: 'planner', status: 'working' });
  assert.ok(patch, 'patch should not be null');
  assert.strictEqual(patch.type, 'agent');
  assert.strictEqual(patch.id, 'a1');
  const snap = s.snapshot();
  assert.ok(snap.agents.a1);
  assert.strictEqual(snap.agents.a1.name, 'planner');
  assert.strictEqual(snap.agents.a1.status, 'working');
});

test('applyEvent AGENT_UPDATE merges fields on a second update for same id', () => {
  const s = new StateModel();
  s.applyEvent(EVENTS.AGENT_UPDATE, { id: 'a1', name: 'planner', status: 'working' });
  s.applyEvent(EVENTS.AGENT_UPDATE, { id: 'a1', status: 'done' });
  const snap = s.snapshot();
  assert.strictEqual(snap.agents.a1.name, 'planner');
  assert.strictEqual(snap.agents.a1.status, 'done');
});

test('applyEvent COUNTS_UPDATE merges into counts and returns a patch', () => {
  const s = new StateModel();
  s.applyEvent(EVENTS.COUNTS_UPDATE, { running: 2, done: 5 });
  const patch = s.applyEvent(EVENTS.COUNTS_UPDATE, { done: 7 });
  assert.strictEqual(patch.type, 'counts');
  const snap = s.snapshot();
  assert.strictEqual(snap.counts.running, 2);
  assert.strictEqual(snap.counts.done, 7);
});

test('applyEvent JOURNAL_APPEND pushes to journal', () => {
  const s = new StateModel();
  const entry = { ts: 123, text: 'hello' };
  const patch = s.applyEvent(EVENTS.JOURNAL_APPEND, entry);
  assert.strictEqual(patch.type, 'journal');
  const snap = s.snapshot();
  assert.strictEqual(snap.journal.length, 1);
  assert.strictEqual(snap.journal[0].text, 'hello');
});

test('snapshot returns an independent copy (mutating snapshot does not affect state)', () => {
  const s = new StateModel();
  s.applyEvent(EVENTS.AGENT_UPDATE, { id: 'a1', name: 'x' });
  const snap = s.snapshot();
  snap.agents.a1.name = 'mutated';
  snap.counts.injected = 999;
  assert.strictEqual(s.agents.a1.name, 'x');
  assert.strictEqual(s.counts.injected, undefined);
});

test('applyEvent returns null for an unknown event name', () => {
  const s = new StateModel();
  const patch = s.applyEvent('not:a:real:event', { id: 'x' });
  assert.strictEqual(patch, null);
});
