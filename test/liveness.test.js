const test = require('node:test');
const assert = require('node:assert');
const { createReconciler } = require('../src/liveness');
const { createEventBus, EVENTS } = require('../src/eventBus');

// Deterministic fake clock: timers fire only when advance() crosses their due
// time, in due-time order.
function makeFakeTimer() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    now() {
      return now;
    },
    advance(ms) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) {
        timers.delete(id);
        t.fn();
      }
    },
  };
}

function collect(bus) {
  const events = [];
  bus.on(EVENTS.AGENT_ENTER, (p) => events.push({ type: 'enter', p }));
  bus.on(EVENTS.AGENT_UPDATE, (p) => events.push({ type: 'update', p }));
  bus.on(EVENTS.AGENT_EXIT, (p) => events.push({ type: 'exit', p }));
  bus.on(EVENTS.EDGE_UPDATE, (p) => events.push({ type: 'edge', p }));
  return events;
}

const A = {
  id: 'idA',
  name: 'voltron-A',
  nodeId: 'A',
  agent: 'A',
  createdAt: '2026-06-09 10:00:00 +0000 UTC',
  state: 'running',
  status: 'Up 1 second',
};
const B = {
  id: 'idB',
  name: 'voltron-B',
  nodeId: 'B',
  agent: 'B',
  createdAt: '2026-06-09 10:00:01 +0000 UTC',
  state: 'running',
  status: 'Up 1 second',
};

test('docker poll of [A,B] emits two enters and an edge set of hub + 2 spokes', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer });

  r.applyDockerPoll({ available: true, containers: [A, B] });

  const enters = ev.filter((e) => e.type === 'enter');
  assert.strictEqual(enters.length, 2);
  assert.deepStrictEqual(
    enters.map((e) => e.p.nodeId).sort(),
    ['A', 'B']
  );
  for (const e of enters) {
    assert.strictEqual(e.p.state, 'dispatching');
  }

  const edgeEvents = ev.filter((e) => e.type === 'edge');
  assert.ok(edgeEvents.length >= 1);
  const last = edgeEvents[edgeEvents.length - 1].p;
  assert.strictEqual(last.hub, 'scrum-master');
  assert.strictEqual(last.edges.length, 2);
  for (const edge of last.edges) {
    assert.strictEqual(edge.source, 'scrum-master');
    assert.strictEqual(edge.kind, 'dispatch');
    assert.strictEqual(edge.inferred, true);
  }
});

test('a poll that omits B winds B down, then AGENT_EXIT fires after linger and the spoke drops', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer, lingerMs: 2500 });

  r.applyDockerPoll({ available: true, containers: [A, B] });
  ev.length = 0;

  r.applyDockerPoll({ available: true, containers: [A] });

  const bUpdates = ev.filter((e) => e.type === 'update' && e.p.nodeId === 'B');
  assert.strictEqual(bUpdates.length, 1);
  assert.strictEqual(bUpdates[0].p.state, 'exiting:done');
  assert.strictEqual(ev.filter((e) => e.type === 'exit').length, 0);

  timer.advance(2600);

  const exits = ev.filter((e) => e.type === 'exit');
  assert.strictEqual(exits.length, 1);
  assert.strictEqual(exits[0].p.nodeId, 'B');

  const edgeEvents = ev.filter((e) => e.type === 'edge');
  const last = edgeEvents[edgeEvents.length - 1].p;
  assert.strictEqual(last.edges.length, 1);
  assert.strictEqual(last.edges[0].target, 'A');

  const snap = r.getLiveSet();
  assert.strictEqual(snap.liveAgents.length, 1);
  assert.strictEqual(snap.liveAgents[0].nodeId, 'A');
});

test('log [exec]/[STEP]/[exit] drive working, step label, then fast-path exit + linger; hub disappears when empty', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer, lingerMs: 2500 });

  r.applyDockerPoll({ available: true, containers: [A] });
  ev.length = 0;

  // [exec]
  r.applyLogEvent({ nodeId: 'A', state: 'working', exitCode: null, latestStep: null });
  let updates = ev.filter((e) => e.type === 'update');
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].p.state, 'working');
  assert.strictEqual(updates[0].p.step, null);

  // [STEP 2] doing x
  r.applyLogEvent({
    nodeId: 'A',
    state: 'working',
    exitCode: null,
    latestStep: '[STEP 2] doing x',
  });
  updates = ev.filter((e) => e.type === 'update');
  assert.strictEqual(updates[updates.length - 1].p.state, 'working');
  assert.strictEqual(updates[updates.length - 1].p.step, '[STEP 2] doing x');

  // [exit] code=0
  r.applyLogEvent({ nodeId: 'A', state: 'done', exitCode: 0, latestStep: '[DONE] ok' });
  const exitingUpdates = ev.filter(
    (e) => e.type === 'update' && e.p.state === 'exiting:done'
  );
  assert.strictEqual(exitingUpdates.length, 1);
  assert.strictEqual(ev.filter((e) => e.type === 'exit').length, 0);

  timer.advance(2600);

  const exits = ev.filter((e) => e.type === 'exit');
  assert.strictEqual(exits.length, 1);
  assert.strictEqual(exits[0].p.nodeId, 'A');
  assert.strictEqual(exits[0].p.exitCode, 0);

  const edgeEvents = ev.filter((e) => e.type === 'edge');
  const last = edgeEvents[edgeEvents.length - 1].p;
  assert.strictEqual(last.hub, null);
  assert.strictEqual(last.edges.length, 0);
  assert.strictEqual(r.getLiveSet().liveAgents.length, 0);
});

test('a single available:false poll is treated as no-change (live set not torn down)', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer });

  r.applyDockerPoll({ available: true, containers: [A, B] });
  ev.length = 0;

  r.applyDockerPoll({ available: false, containers: [] });

  assert.strictEqual(ev.filter((e) => e.type === 'exit').length, 0);
  assert.strictEqual(ev.filter((e) => e.type === 'update').length, 0);

  const snap = r.getLiveSet();
  assert.strictEqual(snap.liveAgents.length, 2);
  assert.strictEqual(snap.dockerAvailable, false);

  timer.advance(10000);
  assert.strictEqual(r.getLiveSet().liveAgents.length, 2);
});
