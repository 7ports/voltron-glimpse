const test = require('node:test');
const assert = require('node:assert');
const { StateModel } = require('../src/state');
const { EVENTS } = require('../src/eventBus');

test('StateModel constructor initializes the live model', () => {
  const s = new StateModel();
  assert.deepStrictEqual(s.liveAgents, {});
  assert.deepStrictEqual(s.edges, []);
  assert.strictEqual(s.dockerAvailable, false);
});

test('AGENT_ENTER adds a live agent reflected in the snapshot', () => {
  const s = new StateModel();
  const patch = s.applyEvent(EVENTS.AGENT_ENTER, {
    nodeId: 'A',
    agent: 'fullstack-dev',
    containerName: 'voltron-A',
    createdAt: 'now',
    state: 'dispatching',
  });
  assert.ok(patch, 'patch should not be null');
  assert.strictEqual(patch.type, 'enter');
  assert.strictEqual(patch.nodeId, 'A');
  const snap = s.snapshot();
  assert.ok(snap.liveAgents.A);
  assert.strictEqual(snap.liveAgents.A.agent, 'fullstack-dev');
  assert.strictEqual(snap.liveAgents.A.state, 'dispatching');
});

test('AGENT_UPDATE merges state/step into an existing live agent', () => {
  const s = new StateModel();
  s.applyEvent(EVENTS.AGENT_ENTER, { nodeId: 'A', agent: 'x', state: 'dispatching' });
  const patch = s.applyEvent(EVENTS.AGENT_UPDATE, {
    nodeId: 'A',
    state: 'working',
    step: '[STEP 2] doing x',
  });
  assert.strictEqual(patch.type, 'update');
  const snap = s.snapshot();
  assert.strictEqual(snap.liveAgents.A.agent, 'x'); // preserved
  assert.strictEqual(snap.liveAgents.A.state, 'working');
  assert.strictEqual(snap.liveAgents.A.step, '[STEP 2] doing x');
});

test('AGENT_UPDATE for an unknown node is ignored (no agent created)', () => {
  const s = new StateModel();
  const patch = s.applyEvent(EVENTS.AGENT_UPDATE, { nodeId: 'ghost', state: 'working' });
  assert.strictEqual(patch, null);
  assert.deepStrictEqual(s.snapshot().liveAgents, {});
});

test('AGENT_EXIT removes the agent from the live set', () => {
  const s = new StateModel();
  s.applyEvent(EVENTS.AGENT_ENTER, { nodeId: 'A', agent: 'x', state: 'working' });
  const patch = s.applyEvent(EVENTS.AGENT_EXIT, { nodeId: 'A', exitCode: 0 });
  assert.strictEqual(patch.type, 'exit');
  assert.strictEqual(patch.nodeId, 'A');
  assert.deepStrictEqual(s.snapshot().liveAgents, {});
});

test('enter → update → exit is reflected end-to-end in the snapshot', () => {
  const s = new StateModel();
  s.applyEvent(EVENTS.AGENT_ENTER, { nodeId: 'A', agent: 'x', state: 'dispatching' });
  s.applyEvent(EVENTS.AGENT_UPDATE, { nodeId: 'A', state: 'working' });
  assert.strictEqual(s.snapshot().liveAgents.A.state, 'working');
  s.applyEvent(EVENTS.AGENT_EXIT, { nodeId: 'A' });
  assert.strictEqual(s.snapshot().liveAgents.A, undefined);
});

test('EDGE_UPDATE replaces the edges array', () => {
  const s = new StateModel();
  const edges = [
    { id: 'scrum-master->A', source: 'scrum-master', target: 'A', kind: 'dispatch', inferred: true },
  ];
  const patch = s.applyEvent(EVENTS.EDGE_UPDATE, { hub: 'scrum-master', edges });
  assert.strictEqual(patch.type, 'edges');
  assert.strictEqual(s.snapshot().edges.length, 1);
  assert.strictEqual(s.snapshot().edges[0].target, 'A');

  // A subsequent EDGE_UPDATE fully replaces (not appends).
  s.applyEvent(EVENTS.EDGE_UPDATE, { hub: null, edges: [] });
  assert.deepStrictEqual(s.snapshot().edges, []);
});

test('dockerAvailable is tracked when carried on any event', () => {
  const s = new StateModel();
  assert.strictEqual(s.snapshot().dockerAvailable, false);
  s.applyEvent(EVENTS.EDGE_UPDATE, { hub: null, edges: [], dockerAvailable: true });
  assert.strictEqual(s.snapshot().dockerAvailable, true);
});

test('snapshot returns an independent copy (mutating snapshot does not affect state)', () => {
  const s = new StateModel();
  s.applyEvent(EVENTS.AGENT_ENTER, { nodeId: 'A', agent: 'x' });
  const snap = s.snapshot();
  snap.liveAgents.A.agent = 'mutated';
  snap.edges.push({ id: 'injected' });
  assert.strictEqual(s.liveAgents.A.agent, 'x');
  assert.strictEqual(s.edges.length, 0);
});

test('applyEvent returns null for an unknown event name', () => {
  const s = new StateModel();
  assert.strictEqual(s.applyEvent('not:a:real:event', { nodeId: 'x' }), null);
});

// --- Scrum-master hub field (B4) ------------------------------------------
test('HUB_UPDATE creates the hub and snapshot() returns it', () => {
  const s = new StateModel();
  const patch = s.applyEvent(EVENTS.HUB_UPDATE, {
    id: 'scrum-master',
    present: true,
    state: 'active',
    label: 'Decomposing backlog',
    kind: 'note',
    emoji: '\u{1F4DD}',
    time: '10:00',
  });
  assert.ok(patch);
  assert.strictEqual(patch.type, 'hub');
  const snap = s.snapshot();
  assert.ok(snap.hub);
  assert.strictEqual(snap.hub.id, 'scrum-master');
  assert.strictEqual(snap.hub.state, 'active');
  assert.strictEqual(snap.hub.label, 'Decomposing backlog');
});

test('an idle HUB_UPDATE mutates the hub in place (no accumulation)', () => {
  const s = new StateModel();
  s.applyEvent(EVENTS.HUB_UPDATE, {
    id: 'scrum-master',
    present: true,
    state: 'active',
    label: 'working',
    kind: 'note',
  });
  const before = s.hub;
  s.applyEvent(EVENTS.HUB_UPDATE, {
    id: 'scrum-master',
    present: true,
    state: 'idle',
    label: 'working',
    kind: 'note',
  });
  assert.strictEqual(s.hub, before, 'same object reference — mutated in place');
  assert.strictEqual(s.hub.state, 'idle');
  assert.strictEqual(s.snapshot().hub.state, 'idle');
});

test('HUB_UPDATE with present:false removes the hub (nulls it)', () => {
  const s = new StateModel();
  s.applyEvent(EVENTS.HUB_UPDATE, {
    id: 'scrum-master',
    present: true,
    state: 'active',
    label: 'x',
  });
  assert.ok(s.snapshot().hub);
  const patch = s.applyEvent(EVENTS.HUB_UPDATE, { id: 'scrum-master', present: false });
  assert.strictEqual(patch.type, 'hub');
  assert.strictEqual(patch.hub, null);
  assert.strictEqual(s.snapshot().hub, null);
});

test('snapshot hub is an independent copy (mutating snapshot does not affect state)', () => {
  const s = new StateModel();
  s.applyEvent(EVENTS.HUB_UPDATE, {
    id: 'scrum-master',
    present: true,
    state: 'active',
    label: 'x',
  });
  const snap = s.snapshot();
  snap.hub.label = 'mutated';
  assert.strictEqual(s.hub.label, 'x');
});
