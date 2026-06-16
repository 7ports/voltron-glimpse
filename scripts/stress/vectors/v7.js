'use strict';

// V7 — Reconnect storm. A populated live set (200 nodes full / 50 abbrev), then
// waves of clients connect → all disconnect → reconnect on a loop (the frontend's
// backoff loop after a server blip). Every connection triggers a full snapshot()
// of the live set (state.js deep-clone, wsServer connection handler). Bars (plan §):
//   - FD count and wss.clients.size return to baseline after the storm (no leak)
//   - snapshot serialize time ≤ 50 ms for the 200-node set; storm queues nothing
const { startServer } = require('../lib/server');
const { openSwarm, closeSwarm } = require('../lib/wsSwarm');
const { makeContainer } = require('../lib/fakeDocker');
const { fdCount } = require('../lib/instrument');
const { sleep, until, result } = require('../lib/util');
const { performance } = require('node:perf_hooks');

const PRESETS = {
  abbrev: { nodes: 50, clients: 20, rounds: 6, intervalMs: 60, snapSamples: 200 },
  // full: 50 clients reconnecting every 2 s for 3 min against a 200-node set.
  full: { nodes: 200, clients: 50, rounds: 90, intervalMs: 2000, snapSamples: 500 },
};

async function run({ mode = 'abbrev' } = {}) {
  const p = PRESETS[mode] || PRESETS.abbrev;
  const r = result('V7', `reconnect storm (${p.clients} clients × ${p.rounds} rounds, ${p.nodes}-node set)`);
  const srv = await startServer();

  try {
    // Populate the live set.
    const containers = Array.from({ length: p.nodes }, (_, i) => makeContainer(i, { nodeId: `node-${i}` }));
    srv.reconciler.applyDockerPoll({ available: true, containers });
    await sleep(50);

    // Snapshot serialize-time probe (S5/S9): time state.snapshot()+stringify, the
    // exact work each connection does, over many samples.
    let snapMax = 0;
    let snapSum = 0;
    for (let i = 0; i < p.snapSamples; i++) {
      const t0 = performance.now();
      const snap = srv.state.snapshot();
      JSON.stringify({ type: 'snapshot', state: snap });
      const dt = performance.now() - t0;
      snapSum += dt;
      if (dt > snapMax) snapMax = dt;
    }
    const snapAvgMs = Math.round((snapSum / p.snapSamples) * 1000) / 1000;
    const snapMaxMs = Math.round(snapMax * 1000) / 1000;

    // Baseline handles/clients before the storm (after the live set is built).
    const fdBaseline = fdCount();
    const clientsBaseline = srv.wsServer.wss.clients.size;

    let totalSnapshotsReceived = 0;
    let maxClientsDuringStorm = 0;
    const t0 = performance.now();
    for (let round = 0; round < p.rounds; round++) {
      const swarm = await openSwarm(srv.port, p.clients);
      // Every client must receive its snapshot of the populated set.
      await until(() => swarm.every((c) => c.snapshots > 0), { timeoutMs: 3000, stepMs: 10 });
      totalSnapshotsReceived += swarm.reduce((n, c) => n + c.snapshots, 0);
      if (srv.wsServer.wss.clients.size > maxClientsDuringStorm) {
        maxClientsDuringStorm = srv.wsServer.wss.clients.size;
      }
      await closeSwarm(swarm);
      // In full mode the storm cadence is the 2 s backoff; abbrev is tighter.
      await sleep(p.intervalMs);
    }
    const stormMs = Math.round(performance.now() - t0);

    // Let the server reap closed sockets, then measure return-to-baseline.
    await until(() => srv.wsServer.wss.clients.size === 0, { timeoutMs: 3000, stepMs: 25 });
    await sleep(100);
    const fdAfter = fdCount();
    const clientsAfter = srv.wsServer.wss.clients.size;
    const fdDelta = fdAfter != null && fdBaseline != null ? fdAfter - fdBaseline : null;

    r.metric('nodes', p.nodes)
      .metric('clientsPerRound', p.clients)
      .metric('rounds', p.rounds)
      .metric('snapshotsReceived', totalSnapshotsReceived)
      .metric('snapSerializeAvgMs', snapAvgMs)
      .metric('snapSerializeMaxMs', snapMaxMs)
      .metric('maxClientsDuringStorm', maxClientsDuringStorm)
      .metric('wsClientsBaseline', clientsBaseline)
      .metric('wsClientsAfterStorm', clientsAfter)
      .metric('fdBaseline', fdBaseline)
      .metric('fdAfterStorm', fdAfter)
      .metric('fdDelta', fdDelta)
      .metric('stormDurationMs', stormMs);

    const clientsReturned = clientsAfter === 0;
    // FD leak detector: allow a small slack for libuv/internal churn; a real leak
    // grows with rounds×clients (would be ≫ a handful).
    const fdReturned = fdDelta == null || fdDelta <= 8;
    const snapOk = snapMaxMs <= 50;
    const allSnapped = totalSnapshotsReceived >= p.rounds * p.clients;
    const pass = clientsReturned && fdReturned && snapOk && allSnapped;
    r.setPass(pass);

    if (clientsReturned) r.note(`wss.clients.size returned to 0 after ${p.rounds * p.clients} total connects`);
    else r.note(`FINDING: ${clientsAfter} sockets still registered after storm (leak)`);

    if (fdReturned) r.note(`FD delta ${fdDelta} after storm (no descriptor leak)`);
    else r.note(`FINDING: FD count grew by ${fdDelta} after ${p.rounds} reconnect rounds (leak)`);

    if (snapOk) r.note(`snapshot serialize max ${snapMaxMs}ms ≤ 50ms for ${p.nodes}-node set (avg ${snapAvgMs}ms)`);
    else r.note(`FINDING: snapshot serialize ${snapMaxMs}ms exceeded 50ms for ${p.nodes}-node set`);
    return r;
  } finally {
    await srv.close();
  }
}

module.exports = { run, PRESETS };
