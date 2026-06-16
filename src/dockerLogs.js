'use strict';

const { spawn } = require('node:child_process');

// Read-only: stream a container's stdout/stderr. `docker logs` NEVER mutates a
// container (unlike run/stop/rm/exec). `--tail` bounds the initial replay so we
// don't flood on attach; `-f` follows for subsequent output.
function buildLogsArgs(containerId, tail) {
  return ['logs', '-f', '--tail', String(tail), containerId];
}

function defaultSpawn(args) {
  // stdin ignored (we never write to the container); stdout+stderr piped so we
  // can observe the first byte of activity.
  return spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

// Manage short-lived, read-only `docker logs -f` tails — one per live container —
// as an EARLY activity signal. The `.voltron/logs` enrichment is authoritative but
// laggy: a container can be visibly thinking (streaming to `docker logs`) for a
// while before its first `[exec]`/`[STEP]` line lands, leaving the node stuck on
// `dispatching`. This tailer proves liveness from the FIRST byte the container
// emits and reports it via onActivity(nodeId), advancing the node to `working`
// immediately. Each tail is torn down as soon as it yields activity (its job is
// done — one byte is enough) or when its container leaves the live set / exits, so
// no long-lived follow process accumulates per agent. Strictly read-only and
// degrades silently if `docker` cannot be spawned.
function createDockerLogTailer({ spawn: spawnFn, onActivity, tail = 10 } = {}) {
  const doSpawn = typeof spawnFn === 'function' ? spawnFn : defaultSpawn;
  const notify = typeof onActivity === 'function' ? onActivity : function () {};

  // nodeId -> active child process (a tail in flight, not yet fired).
  const tails = new Map();
  // nodeIds whose activity has already been reported. Kept so a steady-state sync
  // never re-spawns a tail for a container we already advanced to `working`.
  const signaled = new Set();

  function stopTail(nodeId) {
    const child = tails.get(nodeId);
    if (!child) return;
    tails.delete(nodeId);
    try {
      if (typeof child.kill === 'function') child.kill();
    } catch (_e) {
      /* ignore kill errors — the process may already be gone */
    }
  }

  function startTail(nodeId, containerId) {
    if (!nodeId || !containerId) return;
    if (tails.has(nodeId) || signaled.has(nodeId)) return;

    let child;
    try {
      child = doSpawn(buildLogsArgs(containerId, tail));
    } catch (_e) {
      return; // docker binary missing / spawn refused — degrade silently
    }
    if (!child) return;
    tails.set(nodeId, child);

    let fired = false;
    function onData(chunk) {
      if (fired) return;
      if (!chunk || chunk.length === 0) return;
      fired = true;
      signaled.add(nodeId);
      stopTail(nodeId); // first byte is all we need; release the follow process
      notify(nodeId);
    }

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', onData);
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', onData);
    }
    if (typeof child.on === 'function') {
      // A tail that errors or closes (container exited, no output) is simply
      // dropped from the active set; it never threw an unobserved 'error'.
      child.on('error', function () {
        tails.delete(nodeId);
      });
      child.on('close', function () {
        tails.delete(nodeId);
      });
    }
  }

  // Reconcile active tails to exactly the supplied live containers. `containers`
  // is the scoped docker-poll list (each { nodeId, id, ... }). New containers get a
  // tail; containers that left the live set have their tail torn down and their
  // signaled flag cleared (a container's nodeId is unique per run, so this is just
  // hygiene). Call only when the daemon answered this tick.
  function sync(containers) {
    const want = new Map(); // nodeId -> containerId
    for (const c of Array.isArray(containers) ? containers : []) {
      if (c && c.nodeId && c.id) want.set(c.nodeId, c.id);
    }
    for (const [nodeId, id] of want) {
      startTail(nodeId, id);
    }
    for (const nodeId of Array.from(tails.keys())) {
      if (!want.has(nodeId)) stopTail(nodeId);
    }
    for (const nodeId of Array.from(signaled)) {
      if (!want.has(nodeId)) signaled.delete(nodeId);
    }
  }

  // Tear down every tail (used on shutdown). Leaves no child process behind.
  function close() {
    for (const nodeId of Array.from(tails.keys())) stopTail(nodeId);
    signaled.clear();
  }

  return {
    sync,
    close,
    // test/introspection hooks (not part of the runtime contract)
    activeCount: function () {
      return tails.size;
    },
  };
}

module.exports = { createDockerLogTailer, buildLogsArgs };
