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
  bus.on(EVENTS.HUB_UPDATE, (p) => events.push({ type: 'hub', p }));
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
  selfPod: true,
};
const B = {
  id: 'idB',
  name: 'voltron-B',
  nodeId: 'B',
  agent: 'B',
  createdAt: '2026-06-09 10:00:01 +0000 UTC',
  state: 'running',
  status: 'Up 1 second',
  selfPod: true,
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

// --- Scrum-master hub liveness (B3) ---------------------------------------
const HUB = 'scrum-master';
function makeJournal(over) {
  return Object.assign(
    {
      time: '10:00',
      date: '2026-06-09',
      kind: 'dispatch',
      agent: 'scrum-master',
      text: 'Dispatched fullstack-dev',
      emoji: '→',
    },
    over || {}
  );
}

test('applyJournalEvent sets the hub active and emits HUB_UPDATE(active)', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer, hubFreshnessMs: 60000 });

  r.applyJournalEvent(makeJournal({ text: 'Decomposing backlog', kind: 'note' }));

  const hubEvents = ev.filter((e) => e.type === 'hub');
  assert.ok(hubEvents.length >= 1);
  const last = hubEvents[hubEvents.length - 1].p;
  assert.strictEqual(last.id, HUB);
  assert.strictEqual(last.state, 'active');
  assert.strictEqual(last.label, 'Decomposing backlog');
  assert.strictEqual(last.kind, 'note');

  const snap = r.snapshot();
  assert.ok(snap.hub);
  assert.strictEqual(snap.hub.state, 'active');
  assert.strictEqual(snap.hub.label, 'Decomposing backlog');
});

test('hub is present with ZERO agents while journal-active (hub alone, no spokes)', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer, hubFreshnessMs: 60000 });

  r.applyJournalEvent(makeJournal());

  const snap = r.snapshot();
  assert.ok(snap.hub, 'hub present with zero agents while active');
  assert.strictEqual(snap.liveAgents.length, 0);
  assert.strictEqual(snap.edges.length, 0);

  const edgeEvents = ev.filter((e) => e.type === 'edge');
  const lastEdge = edgeEvents[edgeEvents.length - 1].p;
  assert.strictEqual(lastEdge.hub, HUB);
  assert.strictEqual(lastEdge.edges.length, 0);
});

test('hub flips active -> idle after hubFreshnessMs and is removed when idle AND empty', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer, hubFreshnessMs: 60000 });

  r.applyJournalEvent(makeJournal());
  assert.strictEqual(r.snapshot().hub.state, 'active');
  ev.length = 0;

  timer.advance(60001);

  const hubEvents = ev.filter((e) => e.type === 'hub');
  assert.ok(hubEvents.length >= 1);
  const last = hubEvents[hubEvents.length - 1].p;
  assert.strictEqual(last.id, HUB);
  assert.strictEqual(last.present, false);
  assert.strictEqual(r.snapshot().hub, null);
});

test('a live agent keeps the hub present after the journal goes stale (dims to idle)', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer, hubFreshnessMs: 60000 });

  r.applyDockerPoll({ available: true, containers: [A] });
  r.applyJournalEvent(makeJournal());
  assert.strictEqual(r.snapshot().hub.state, 'active');
  ev.length = 0;

  timer.advance(60001);

  const snap = r.snapshot();
  assert.ok(snap.hub, 'hub stays present while an agent is live');
  assert.strictEqual(snap.hub.state, 'idle');

  const hubEvents = ev.filter((e) => e.type === 'hub');
  const last = hubEvents[hubEvents.length - 1].p;
  assert.strictEqual(last.state, 'idle');
  assert.strictEqual(last.present, true);
});

// --- Dispatch-spoke correlation flash (B7, §3.5) --------------------------

test('dispatch journal naming A + a container A entering within the window flashes A\'s spoke', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer, dispatchWindowMs: 10000 });

  r.applyJournalEvent(makeJournal({ kind: 'dispatch', text: 'Dispatched A (B1) to do work' }));
  timer.advance(3000); // still inside the 10 s correlation window
  r.applyDockerPoll({ available: true, containers: [A] });

  const enterA = ev.filter((e) => e.type === 'enter' && e.p.nodeId === 'A');
  assert.strictEqual(enterA.length, 1);
  assert.strictEqual(enterA[0].p.dispatchFlash, true);
});

test('a same-named agent in a FOREIGN pod does NOT get the self pod\'s flash', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer, dispatchWindowMs: 10000 });

  // The journal (self pod) dispatches agent A; only a foreign-pod container A
  // enters within the window. The flash must NOT cross pods.
  const foreignA = { ...A, selfPod: false };
  r.applyJournalEvent(
    makeJournal({ kind: 'dispatch', text: 'Dispatched A (B1) to implement the WS handler' })
  );
  timer.advance(3000); // inside the correlation window
  r.applyDockerPoll({ available: true, containers: [foreignA] });

  const enterA = ev.filter((e) => e.type === 'enter' && e.p.nodeId === 'A');
  assert.strictEqual(enterA.length, 1);
  assert.ok(!enterA[0].p.dispatchFlash, 'foreign-pod container gets no self-pod flash');
  const a = r.snapshot().liveAgents.find((e) => e.nodeId === 'A');
  assert.strictEqual(a.dispatchTaskText, null, 'no self-pod task prose attached cross-pod');
});

test('a container entering AFTER the correlation window does NOT flash', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer, dispatchWindowMs: 10000 });

  r.applyJournalEvent(makeJournal({ kind: 'dispatch', text: 'Dispatched A (B1) to do work' }));
  timer.advance(10001); // past the window -> pending dispatch expires
  r.applyDockerPoll({ available: true, containers: [A] });

  const enterA = ev.filter((e) => e.type === 'enter' && e.p.nodeId === 'A');
  assert.strictEqual(enterA.length, 1);
  assert.ok(!enterA[0].p.dispatchFlash, 'no flash once the window has lapsed');
});

test('a container entering with no preceding dispatch enters normally with no flash', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer, dispatchWindowMs: 10000 });

  r.applyDockerPoll({ available: true, containers: [A] });

  const enterA = ev.filter((e) => e.type === 'enter' && e.p.nodeId === 'A');
  assert.strictEqual(enterA.length, 1);
  assert.strictEqual(enterA[0].p.state, 'dispatching');
  assert.ok(!enterA[0].p.dispatchFlash, 'normal enter carries no flash hint');
});

test('hub vanishes when the last live agent exits while the journal is already idle', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const r = createReconciler({ bus, timer, lingerMs: 2500, hubFreshnessMs: 60000 });

  r.applyDockerPoll({ available: true, containers: [A] });
  r.applyJournalEvent(makeJournal());
  timer.advance(60001); // journal idle, agent A still live -> hub idle but present
  assert.strictEqual(r.snapshot().hub.state, 'idle');

  r.applyDockerPoll({ available: true, containers: [] }); // A leaves docker
  timer.advance(2600); // linger elapses -> A exits

  assert.strictEqual(r.snapshot().liveAgents.length, 0);
  assert.strictEqual(r.snapshot().hub, null);
});

// --- Agent detail panel retention (build-steps 2 & 3) ---------------------

test('applyLogEvent retains execTs once + stepCount + newest-first recentSteps, with NO fs write', () => {
  const fs = require('node:fs');
  const guarded = [
    'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
    'mkdir', 'mkdirSync', 'rm', 'rmSync', 'unlink', 'unlinkSync',
  ];
  const origs = {};
  let writes = 0;
  for (const fn of guarded) {
    origs[fn] = fs[fn];
    fs[fn] = (...args) => {
      writes += 1;
      return undefined;
    };
  }

  try {
    const timer = makeFakeTimer();
    const bus = createEventBus();
    const r = createReconciler({ bus, timer });

    r.applyDockerPoll({ available: true, containers: [A] });

    // [exec] sets execTs once
    r.applyLogEvent({
      nodeId: 'A', state: 'working', exitCode: null, latestStep: null,
      execTs: '2026-06-09T10:00:01+00:00', steps: [],
    });
    // three numbered steps (later execTs values must be ignored)
    r.applyLogEvent({
      nodeId: 'A', state: 'working', exitCode: null, latestStep: '[STEP 1] a',
      stepNum: 1, execTs: 'IGNORED', steps: [{ stepNum: 1, text: '[STEP 1] a' }],
    });
    r.applyLogEvent({
      nodeId: 'A', state: 'working', exitCode: null, latestStep: '[STEP 2] b',
      stepNum: 2, steps: [{ stepNum: 2, text: '[STEP 2] b' }],
    });
    r.applyLogEvent({
      nodeId: 'A', state: 'working', exitCode: null, latestStep: '[STEP 3] c',
      stepNum: 3, steps: [{ stepNum: 3, text: '[STEP 3] c' }],
    });

    const snap = r.snapshot();
    const a = snap.liveAgents.find((e) => e.nodeId === 'A');
    assert.ok(a);
    assert.strictEqual(a.stepCount, 3);
    assert.strictEqual(a.recentSteps.length, 3);
    // newest-first
    assert.strictEqual(a.recentSteps[0].stepNum, 3);
    assert.strictEqual(a.recentSteps[2].stepNum, 1);
    // execTs set once, not overwritten
    assert.strictEqual(a.execTs, '2026-06-09T10:00:01+00:00');
    assert.strictEqual(a.stepNum, 3);
  } finally {
    for (const fn of guarded) fs[fn] = origs[fn];
  }

  assert.strictEqual(writes, 0, 'reconciler must perform no fs writes');
});

test('a dispatch journal signal with task text, then a matching enter, carries dispatchTaskText', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const r = createReconciler({ bus, timer, dispatchWindowMs: 10000 });

  r.applyJournalEvent(
    makeJournal({ kind: 'dispatch', text: 'Dispatched A (B1) to implement the WS handler' })
  );
  timer.advance(2000); // inside the correlation window
  r.applyDockerPoll({ available: true, containers: [A] });

  const a = r.snapshot().liveAgents.find((e) => e.nodeId === 'A');
  assert.ok(a);
  assert.strictEqual(a.dispatchTaskText, 'implement the WS handler');
});

// --- Multi-pod observability (foreign-pod log enrichment) -----------------

test('a foreign pod whose logs ARE observed advances dispatching -> working on [exec]', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const r = createReconciler({ bus, timer });

  // Foreign container, but its host log dir resolved -> observed:true.
  const foreignB = { ...B, selfPod: false, observed: true };
  r.applyDockerPoll({ available: true, containers: [foreignB] });

  let b = r.snapshot().liveAgents.find((e) => e.nodeId === 'B');
  assert.ok(b);
  assert.strictEqual(b.observed, true);
  assert.strictEqual(b.state, 'dispatching');

  // Its log dir is now tailed (the watcher routes foreign log events into the SAME
  // reconciler), so [exec] arrives and it advances — no longer stuck.
  r.applyLogEvent({ nodeId: 'B', state: 'working', exitCode: null, latestStep: '[STEP 1] go' });

  b = r.snapshot().liveAgents.find((e) => e.nodeId === 'B');
  assert.strictEqual(b.state, 'working', 'foreign-pod container advances past dispatching');
  assert.strictEqual(b.step, '[STEP 1] go');
  assert.strictEqual(b.observed, true);
});

test('a foreign pod whose log dir is unresolvable is flagged observed:false (honest, not stuck-without-signal)', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer });

  // Foreign container whose host log dir could not be resolved/read.
  const foreignA = { ...A, selfPod: false, observed: false };
  r.applyDockerPoll({ available: true, containers: [foreignA] });

  const enter = ev.find((e) => e.type === 'enter' && e.p.nodeId === 'A');
  assert.ok(enter, 'still enters as a live node');
  assert.strictEqual(enter.p.observed, false, 'enter payload carries observed:false for the UI');

  const a = r.snapshot().liveAgents.find((e) => e.nodeId === 'A');
  assert.strictEqual(a.observed, false, 'snapshot honestly marks the node logs-unobserved');
  // It is honestly represented (observed:false) rather than silently identical to a
  // live dispatching node. The Docker drop still winds it down normally.
  r.applyDockerPoll({ available: true, containers: [] });
  timer.advance(3000);
  assert.strictEqual(r.snapshot().liveAgents.length, 0, 'exits cleanly on Docker drop');
});

test('observed flips false -> true when a previously-unresolved pod resolves on a later poll', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer });

  r.applyDockerPoll({ available: true, containers: [{ ...B, selfPod: false, observed: false }] });
  assert.strictEqual(r.snapshot().liveAgents.find((e) => e.nodeId === 'B').observed, false);
  ev.length = 0;

  // Next poll: the pod mount-source resolved, log dir now readable.
  r.applyDockerPoll({ available: true, containers: [{ ...B, selfPod: false, observed: true }] });

  const upd = ev.filter((e) => e.type === 'update' && e.p.nodeId === 'B' && e.p.observed === true);
  assert.strictEqual(upd.length, 1, 'one AGENT_UPDATE carrying observed:true');
  assert.strictEqual(r.snapshot().liveAgents.find((e) => e.nodeId === 'B').observed, true);
});

test('self-pod and default containers are observed:true (single-pod behavior unchanged)', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const r = createReconciler({ bus, timer });

  r.applyDockerPoll({ available: true, containers: [A, B] }); // A,B selfPod:true, no observed field
  for (const id of ['A', 'B']) {
    const e = r.snapshot().liveAgents.find((x) => x.nodeId === id);
    assert.strictEqual(e.observed, true, `${id} defaults observed:true`);
  }
});

test('a non-matching enter leaves dispatchTaskText null (best-effort, never wrong)', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const r = createReconciler({ bus, timer, dispatchWindowMs: 10000 });

  r.applyJournalEvent(makeJournal({ kind: 'dispatch', text: 'Dispatched A to do X' }));
  timer.advance(2000);
  r.applyDockerPoll({ available: true, containers: [B] }); // B enters, not A

  const b = r.snapshot().liveAgents.find((e) => e.nodeId === 'B');
  assert.ok(b);
  assert.strictEqual(b.dispatchTaskText, null);
});

test('applyDockerLogActivity advances a dispatching node to working without a log event', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer });

  r.applyDockerPoll({ available: true, containers: [A] });
  assert.strictEqual(r.snapshot().liveAgents[0].state, 'dispatching');
  ev.length = 0;

  // Docker-logs tail saw the container's first byte — no `.voltron/logs` event yet.
  r.applyDockerLogActivity('A');

  const updates = ev.filter((e) => e.type === 'update');
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].p.nodeId, 'A');
  assert.strictEqual(updates[0].p.state, 'working');
  assert.strictEqual(r.snapshot().liveAgents[0].state, 'working');
});

test('applyDockerLogActivity is idempotent and never overwrites richer log state', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer });

  r.applyDockerPoll({ available: true, containers: [A] });
  // Logs enrichment already advanced + added a step.
  r.applyLogEvent({ nodeId: 'A', state: 'working', exitCode: null, latestStep: '[STEP 1] x' });
  ev.length = 0;

  // A late docker-logs signal must be a no-op (no event, step preserved).
  r.applyDockerLogActivity('A');
  assert.strictEqual(ev.filter((e) => e.type === 'update').length, 0);
  assert.strictEqual(r.snapshot().liveAgents[0].step, '[STEP 1] x');
});

test('applyDockerLogActivity is a no-op for unknown or winding-down nodes', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const ev = collect(bus);
  const r = createReconciler({ bus, timer, lingerMs: 2500 });

  // Unknown nodeId — never crashes, emits nothing.
  assert.doesNotThrow(() => r.applyDockerLogActivity('ghost'));
  assert.strictEqual(ev.length, 0);

  // Winding-down node — activity must not resurrect it to working.
  r.applyDockerPoll({ available: true, containers: [A] });
  r.applyLogEvent({ nodeId: 'A', state: 'done', exitCode: 0, latestStep: null });
  ev.length = 0;
  r.applyDockerLogActivity('A');
  assert.strictEqual(ev.filter((e) => e.type === 'update').length, 0);
  assert.strictEqual(r.snapshot().liveAgents[0].state, 'exiting:done');
});
