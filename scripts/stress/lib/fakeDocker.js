'use strict';

const { EventEmitter } = require('node:events');

// T1 — Fake `docker ps` exec. Returns an async exec(...) compatible with
// pollDocker({ exec }). `rowsProvider()` returns the *current* membership as an
// array of container descriptors; the membership is whatever the caller flips it
// to over time (count → V1, churn → V2, pods → V10). `opts.isDown()` (optional)
// makes the exec THROW on a tick — exactly what a dead daemon does — so
// pollDocker's catch returns { available:false } (daemon-flap, V8).
//
// Output matches src/docker.js DOCKER_PS_ARGS --format:
//   {{.ID}}\t{{.Names}}\t{{.CreatedAt}}\t{{.State}}\t{{.Status}}
function fakePsExec(rowsProvider, opts = {}) {
  const isDown = typeof opts.isDown === 'function' ? opts.isDown : () => false;
  return async () => {
    if (isDown()) {
      // Mirror the real daemon-down error surface; pollDocker swallows it.
      const err = new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
      err.code = 1;
      throw err;
    }
    const rows = typeof rowsProvider === 'function' ? rowsProvider() || [] : [];
    return rows
      .map((c) =>
        [
          c.id,
          c.name,
          c.createdAt || '2026-06-15 10:00:00 +0000 UTC',
          c.state || 'running',
          c.status || 'Up 1 second',
        ].join('\t')
      )
      .join('\n');
  };
}

// Build a voltron-* container descriptor. nodeId is the name minus the
// `voltron-` prefix (== the log stem), matching src/docker.js deriveNodeId.
function makeContainer(i, over = {}) {
  const agent = over.agent || 'agent';
  const nodeId = over.nodeId || `${agent}-${i}`;
  return {
    id: over.id || `id-${nodeId}`,
    name: `voltron-${nodeId}`,
    nodeId,
    agent,
    createdAt: over.createdAt || '2026-06-15 10:00:00 +0000 UTC',
    state: 'running',
    status: 'Up 1 second',
    ...over,
  };
}

// T2 — Fake `docker logs -f` spawn stub. Each spawn yields a fake child whose
// stdout/stderr are EventEmitters (same shape as test/dockerLogs.test.js). A
// "silent slow-start" container never emits (its follow process stays alive →
// probes S2 process accumulation); an "active" container emits a byte. The stub
// tracks every child and whether it was kill()ed, so the harness can assert that
// no follow process is left un-killed (the S2 FD/PID-exhaustion bar).
function makeFakeLogSpawn() {
  const children = [];
  const calls = [];
  function spawn(args) {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = function () {
      if (child.killed) return true;
      child.killed = true;
      child.emit('close', null, 'SIGTERM');
      return true;
    };
    children.push(child);
    return child;
  }
  return {
    spawn,
    calls,
    children,
    // S2 instrumentation: follow processes spawned but never killed and never
    // self-closed — i.e. leaked. A silent slow-start container that is correctly
    // torn down on leaving the set should NOT count here.
    leakedCount() {
      return children.filter((c) => !c.killed && c.listenerCount('close') >= 0 && c._closed !== true)
        .length;
    },
    aliveCount() {
      return children.filter((c) => !c.killed).length;
    },
  };
}

module.exports = { fakePsExec, makeContainer, makeFakeLogSpawn };
