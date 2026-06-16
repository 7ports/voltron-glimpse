'use strict';

// Startup-after-agents-already-running regression tests (bead glimpse-u7x).
//
// When Glimpse starts AFTER agents are already running, those containers must NOT
// be stuck on `dispatching` — they have long since taken their first action. This
// file proves the startup sequence resolves such containers to `working`, across
// both liveness modes, and that a GENUINELY fresh (no-output-yet) container still
// starts as `dispatching`.
//
// Why this needs dedicated coverage: in Docker mode the self-pod `.voltron/logs`
// watcher seeds its offsets to EOF at scanExisting() (present-tense rule §2.5), so
// it deliberately does NOT replay an already-running container's historical
// [exec]/[STEP] lines. The ONLY thing that lifts such a container off `dispatching`
// at startup is the glimpse-09g docker-logs tailer: `docker logs -f --tail N`
// replays the container's stdout history, whose first byte fires
// applyDockerLogActivity(). These tests wire the REAL tailer to the REAL reconciler
// and drive the exact startup ordering the CLI uses (applyDockerPoll -> tailer.sync
// -> historical replay), so a future refactor that breaks startup-after-agents
// fails here instead of silently in production.

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { createReconciler } = require('../src/liveness');
const { createDockerLogTailer } = require('../src/dockerLogs');
const { createEventBus, EVENTS } = require('../src/eventBus');
const { parseLog } = require('../src/parsers/logs');

// --- Fakes (mirrors test/dockerLogs.test.js + test/liveness.test.js) --------

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = function () {
    child.killed = true;
    child.emit('close', null, 'SIGTERM');
    return true;
  };
  return child;
}

function makeSpawnStub() {
  const calls = [];
  const children = [];
  function spawn(args) {
    calls.push(args);
    const child = makeFakeChild();
    children.push(child);
    return child;
  }
  return { spawn, calls, children };
}

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

// A docker-poll container row (selfPod, as a self-launch container would be).
function container(over) {
  return Object.assign(
    {
      id: 'id-aaa',
      name: 'voltron-fullstack-dev',
      nodeId: 'voltron-fullstack-dev',
      agent: 'fullstack-dev',
      createdAt: '2026-06-12 09:00:00 +0000 UTC',
      selfPod: true,
    },
    over || {}
  );
}

// Wire a real reconciler to a real docker-logs tailer exactly as bin/cli.js does:
// the tailer's onActivity feeds reconciler.applyDockerLogActivity.
function wireDockerMode() {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const spawnStub = makeSpawnStub();
  const r = createReconciler({ bus, timer });
  const tailer = createDockerLogTailer({
    spawn: spawnStub.spawn,
    onActivity: function (nodeId) {
      r.applyDockerLogActivity(nodeId);
    },
  });
  return { timer, bus, r, tailer, spawnStub };
}

function stateOf(r, nodeId) {
  const e = r.snapshot().liveAgents.find((x) => x.nodeId === nodeId);
  return e ? e.state : null;
}

// === Criterion 1: Docker mode — already-running container with prior output ===

test('docker startup: an already-running container with prior output resolves to working (not stuck dispatching)', () => {
  const { r, tailer, spawnStub } = wireDockerMode();

  // CLI startup ordering: first poll creates the entry as `dispatching`...
  const c = container();
  r.applyDockerPoll({ available: true, containers: [c] });
  assert.strictEqual(stateOf(r, c.nodeId), 'dispatching', 'enters dispatching on first poll');

  // ...then the docker-logs tailer is synced and `docker logs --tail N` replays the
  // container's EXISTING stdout history. That historical first byte is the evidence
  // the agent already started working.
  tailer.sync([{ nodeId: c.nodeId, id: c.id }]);
  assert.strictEqual(spawnStub.calls.length, 1, 'one tail spawned for the live container');
  spawnStub.children[0].stdout.emit('data', Buffer.from('[STEP 7] still grinding away\n'));

  assert.strictEqual(
    stateOf(r, c.nodeId),
    'working',
    'history replay promotes the pre-existing container to working'
  );
  // The tail is torn down once it has yielded its one byte of evidence.
  assert.strictEqual(tailer.activeCount(), 0, 'tail released after first byte');
});

// === Criterion 2: Docker mode — a genuinely fresh container stays dispatching ===

test('docker startup: a freshly-dispatched container with no output yet stays dispatching, then advances when it acts', () => {
  const { r, tailer, spawnStub } = wireDockerMode();

  const c = container({ id: 'id-fresh', name: 'voltron-qa-tester', nodeId: 'voltron-qa-tester' });
  r.applyDockerPoll({ available: true, containers: [c] });
  tailer.sync([{ nodeId: c.nodeId, id: c.id }]);

  // A brand-new container has produced nothing yet: `docker logs --tail N` emits no
  // bytes, so the node correctly remains `dispatching` and the tail stays open.
  assert.strictEqual(stateOf(r, c.nodeId), 'dispatching', 'no output => still dispatching');
  assert.strictEqual(tailer.activeCount(), 1, 'tail stays open waiting for first activity');

  // When it later takes its first action, the same path advances it — proving the
  // node is not permanently pinned to dispatching.
  spawnStub.children[0].stdout.emit('data', Buffer.from('booting agent…\n'));
  assert.strictEqual(stateOf(r, c.nodeId), 'working', 'advances on first real output');
});

test('docker startup: a mixed set — only the container with prior output advances', () => {
  const { r, tailer, spawnStub } = wireDockerMode();

  const established = container({ id: 'id-est', name: 'voltron-a', nodeId: 'voltron-a' });
  const fresh = container({ id: 'id-new', name: 'voltron-b', nodeId: 'voltron-b' });
  r.applyDockerPoll({ available: true, containers: [established, fresh] });
  tailer.sync([
    { nodeId: established.nodeId, id: established.id },
    { nodeId: fresh.nodeId, id: fresh.id },
  ]);

  // Replay only the established container's history; the fresh one stays silent.
  const estChild = spawnStub.children[spawnStub.calls.findIndex((a) => a[a.length - 1] === 'id-est')];
  estChild.stdout.emit('data', Buffer.from('[STEP 3] resuming\n'));

  assert.strictEqual(stateOf(r, 'voltron-a'), 'working', 'established container is working');
  assert.strictEqual(stateOf(r, 'voltron-b'), 'dispatching', 'silent fresh container stays dispatching');
});

// === Criterion 3: --no-docker mode — pre-existing .voltron/logs evidence ===

// Mirror bin/cli.js scanLogsForFreshness(): parse a log file's content with the
// REAL parser and map it to a freshness entry exactly as the CLI does, so this
// proves the genuine startup path, not a hand-built shape.
function freshnessEntryFromLog(content, filename, mtimeMs) {
  const parsed = parseLog(content, filename);
  if (!parsed) return null;
  return {
    nodeId: parsed.nodeId,
    agent: parsed.agent,
    containerName: parsed.containerName,
    createdAt: null,
    state: parsed.state,
    exitCode: parsed.exitCode,
    hasExec: parsed.state === 'working',
    mtimeMs,
  };
}

test('no-docker startup: an agent with fresh pre-existing [exec] log evidence resolves to working', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const r = createReconciler({ bus, timer, freshnessMs: 15000 });

  const content = ['[entry] voltron-fullstack-dev', '[exec] 2026-06-12T09:00:00+00:00', '[STEP 1] reading files'].join('\n');
  const entry = freshnessEntryFromLog(content, 'voltron-fullstack-dev.log', timer.now());
  assert.ok(entry, 'log parsed into a freshness entry');

  r.applyLogFreshness([entry]);

  const live = r.snapshot().liveAgents.find((e) => e.nodeId === 'voltron-fullstack-dev');
  assert.ok(live, 'an entry is created for the already-running agent');
  assert.strictEqual(live.state, 'working', 'pre-existing [exec] evidence => working on startup');
});

test('no-docker startup: a container that has only [entry] (no [exec] yet) is NOT shown as working', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const r = createReconciler({ bus, timer, freshnessMs: 15000 });

  // A genuinely fresh container: started, but no first action recorded yet.
  const entry = freshnessEntryFromLog('[entry] voltron-qa-tester', 'voltron-qa-tester.log', timer.now());
  r.applyLogFreshness([entry]);

  assert.strictEqual(
    r.snapshot().liveAgents.length,
    0,
    'no [exec] => log-freshness does not fabricate a working node'
  );
});

test('no-docker startup: a stale [exec] log (older than freshnessMs) is not resurrected to working', () => {
  const timer = makeFakeTimer();
  const bus = createEventBus();
  const r = createReconciler({ bus, timer, freshnessMs: 15000 });

  timer.advance(20000); // clock is now well past the freshness window
  const content = ['[entry] voltron-stale', '[exec] 2026-06-12T08:00:00+00:00'].join('\n');
  const entry = freshnessEntryFromLog(content, 'voltron-stale.log', 0); // mtime far in the past

  r.applyLogFreshness([entry]);

  assert.strictEqual(
    r.snapshot().liveAgents.length,
    0,
    'a stale log is treated as a finished agent, not a live working one'
  );
});

// === Read-only discipline guard for the startup path =======================

test('startup scan performs no fs writes (read-only observer discipline preserved)', () => {
  const fs = require('node:fs');
  const guarded = [
    'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
    'mkdir', 'mkdirSync', 'rm', 'rmSync', 'unlink', 'unlinkSync',
  ];
  const origs = {};
  let writes = 0;
  for (const fn of guarded) {
    origs[fn] = fs[fn];
    fs[fn] = function () {
      writes += 1;
      return undefined;
    };
  }

  try {
    const { r, tailer, spawnStub } = wireDockerMode();
    const c = container();
    r.applyDockerPoll({ available: true, containers: [c] });
    tailer.sync([{ nodeId: c.nodeId, id: c.id }]);
    spawnStub.children[0].stdout.emit('data', Buffer.from('[STEP 1] go\n'));
    tailer.close();
  } finally {
    for (const fn of guarded) fs[fn] = origs[fn];
  }

  assert.strictEqual(writes, 0, 'the startup liveness path must perform zero fs writes');
});
