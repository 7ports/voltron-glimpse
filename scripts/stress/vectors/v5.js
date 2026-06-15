'use strict';

// V5 — WS client fan-out. Escalating concurrent `ws` clients (1 → 10 → 50 → 200
// in full) all draining the feed against ws://127.0.0.1:<port> while V2-style
// churn runs at ~20 events/sec. Loads the per-client JSON.stringify (C × E,
// wsServer.js safeSend) and the per-connect snapshot (state.js deep-clone). Bars:
//   - event→render p95 ≤ 500 ms at the top client level during churn
//   - server stays responsive: a NEW client still gets its snapshot < 1 s
const { startServer } = require('../lib/server');
const { openSwarm, closeSwarm, makeClient } = require('../lib/wsSwarm');
const { makeContainer } = require('../lib/fakeDocker');
const { makeLatencyTracker } = require('../lib/instrument');
const { sleep, until, result } = require('../lib/util');
const { performance } = require('node:perf_hooks');

const PRESETS = {
  abbrev: { levels: [1, 10, 50], churnMs: 1500, tickMs: 50, window: 5 },
  full: { levels: [1, 10, 50, 200], churnMs: 30000, tickMs: 50, window: 5 },
};

async function run({ mode = 'abbrev' } = {}) {
  const p = PRESETS[mode] || PRESETS.abbrev;
  const top = p.levels[p.levels.length - 1];
  const r = result('V5', `WS fan-out (up to ${top} clients during churn)`);
  const srv = await startServer();
  const latency = makeLatencyTracker();
  let swarm = [];

  function attachProbe(client) {
    client.ws.on('message', (data) => {
      let msg = null;
      try {
        msg = JSON.parse(data.toString());
      } catch (_e) {
        return;
      }
      if (msg && msg.type === 'patch' && msg.event === 'agent:enter' && msg.payload) {
        latency.observe(msg.payload.nodeId);
      }
    });
  }

  try {
    const live = [];
    let seq = 0;
    const perLevel = [];
    let worstConnectMs = 0;

    for (const level of p.levels) {
      // Grow the swarm to `level` concurrent clients; the first client is the probe.
      const need = level - swarm.length;
      if (need > 0) {
        const more = await openSwarm(srv.port, need);
        if (swarm.length === 0 && more[0]) attachProbe(more[0]);
        swarm = swarm.concat(more);
      }
      await sleep(50); // let snapshots settle

      // Churn at ~20 ev/s for churnMs while all `level` clients drain.
      const before = latency.count();
      const endAt = performance.now() + p.churnMs;
      while (performance.now() < endAt) {
        const id = `c${seq++}`;
        live.push(id);
        latency.mark(id);
        let exitId = null;
        if (live.length > p.window) exitId = live.shift();
        if (exitId) srv.reconciler.applyLogEvent({ nodeId: exitId, state: 'done', exitCode: 0 });
        srv.reconciler.applyDockerPoll({
          available: true,
          containers: live.map((x) => makeContainer(0, { nodeId: x })),
        });
        await sleep(p.tickMs);
      }
      await sleep(100); // flush in-flight frames

      // Connect-time probe: a brand-new client must get its snapshot < 1 s.
      const c0 = performance.now();
      const fresh = makeClient(srv.port);
      const gotSnap = await until(() => fresh.snapshots > 0, { timeoutMs: 2000, stepMs: 5 });
      const connectMs = Math.round((performance.now() - c0) * 100) / 100;
      if (connectMs > worstConnectMs) worstConnectMs = connectMs;
      await fresh.close();

      const pct = latency.percentiles();
      perLevel.push({ level, p95: pct.p95, connectMs, gotSnap, newSamples: latency.count() - before });
    }

    const pct = latency.percentiles();
    const topLevel = perLevel[perLevel.length - 1];
    r.metric('clientLevels', p.levels.join('→'))
      .metric('latencyP95_topLevelMs', topLevel.p95)
      .metric('latencyP95_allMs', pct.p95)
      .metric('latencyP99_allMs', pct.p99)
      .metric('latencyMaxMs', pct.max)
      .metric('latencySamples', pct.n)
      .metric('worstNewConnectMs', worstConnectMs)
      .metric('perLevel', perLevel.map((l) => `${l.level}c:p95=${l.p95}ms,connect=${l.connectMs}ms`).join(' | '));

    const latOk = topLevel.p95 != null && topLevel.p95 <= 500;
    const connectOk = worstConnectMs <= 1000 && perLevel.every((l) => l.gotSnap);
    const pass = latOk && connectOk;
    r.setPass(pass);

    if (latOk) r.note(`fan-out p95 ${topLevel.p95}ms ≤ 500ms at ${top} clients during churn`);
    else r.note(`FINDING: fan-out p95 ${topLevel.p95}ms exceeded 500ms at ${top} clients`);

    if (connectOk) r.note(`new-connect snapshot worst ${worstConnectMs}ms < 1000ms (server stayed responsive)`);
    else r.note(`FINDING: new-connect snapshot took ${worstConnectMs}ms (≥ 1s) — server saturated`);
    return r;
  } finally {
    await closeSwarm(swarm);
    await srv.close();
  }
}

module.exports = { run, PRESETS };
