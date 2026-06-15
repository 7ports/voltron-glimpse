'use strict';

// V2-short — Container churn. A real in-process Glimpse backend (bus → state →
// reconciler → wsServer on 127.0.0.1) with a 10-client swarm draining the feed,
// while membership churns at ~20 enter+exit/sec. Mixes Docker-drop exits with
// fast-path [exit] log exits to load both reconciler paths. Bars (plan §):
//   - per-event broadcast latency p95 ≤ 300 ms (20 ev/s, 10 clients)
//   - timers/live-set return to baseline after churn drains (no leak)
//   - steady-state RSS bounded (documented)
const { startServer } = require('../lib/server');
const { openSwarm, closeSwarm } = require('../lib/wsSwarm');
const { makeContainer } = require('../lib/fakeDocker');
const { makeLatencyTracker, makeRssSampler, fdCount } = require('../lib/instrument');
const { sleep, until, result } = require('../lib/util');
const { performance } = require('node:perf_hooks');

async function run({ durationMs = 10000, tickMs = 50, clients = 10, window = 5, lingerMs = 2500 } = {}) {
  const r = result('V2', 'container churn (~20 enter+exit/sec, 10 clients)');
  const srv = await startServer({ reconcilerOpts: { lingerMs } });
  const latency = makeLatencyTracker();
  const rss = makeRssSampler(1000);
  const fdBefore = fdCount();
  let swarm = [];

  try {
    swarm = await openSwarm(srv.port, clients);
    // Designate one healthy client as the latency probe: observe the arrival of
    // each AGENT_ENTER patch (correlated by nodeId) → source-stamp→client latency.
    swarm[0].ws.on('message', (data) => {
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

    rss.start();
    let seq = 0;
    const live = [];
    const endAt = performance.now() + durationMs;
    let dockerDropExits = 0;
    let fastPathExits = 0;

    while (performance.now() < endAt) {
      const id = `c${seq++}`;
      live.push(id);
      latency.mark(id); // stamp the source event

      let exitId = null;
      if (live.length > window) exitId = live.shift();
      if (exitId) {
        if (seq % 2 === 0) {
          // fast-path: a log [exit] arrives before the Docker drop
          srv.reconciler.applyLogEvent({ nodeId: exitId, state: 'done', exitCode: 0 });
          fastPathExits++;
        } else {
          dockerDropExits++; // handled by absence in the poll below
        }
      }
      const containers = live.map((x) => makeContainer(0, { nodeId: x }));
      srv.reconciler.applyDockerPoll({ available: true, containers });
      await sleep(tickMs);
    }

    // Stop churn; drain. Empty the docker set and let real linger timers fire.
    srv.reconciler.applyDockerPoll({ available: true, containers: [] });
    const drained = await until(() => srv.reconciler.snapshot().liveAgents.length === 0, {
      timeoutMs: lingerMs * 2 + 2000,
      stepMs: 50,
    });
    rss.stop();

    // Give the probe client a beat to flush any in-flight frames.
    await sleep(100);

    const pct = latency.percentiles();
    const rssReport = rss.report();
    const fdAfter = fdCount();
    const healthyFrames = swarm[1] ? swarm[1].patches : 0;

    r.metric('eventsMarked', seq)
      .metric('latencyP50ms', pct.p50)
      .metric('latencyP95ms', pct.p95)
      .metric('latencyP99ms', pct.p99)
      .metric('latencyMaxms', pct.max)
      .metric('latencySamples', pct.n)
      .metric('dockerDropExits', dockerDropExits)
      .metric('fastPathExits', fastPathExits)
      .metric('liveSetDrainedToZero', drained)
      .metric('rssBaselineMB', rssReport.baselineMB)
      .metric('rssPeakMB', rssReport.peakMB)
      .metric('rssDeltaMB', rssReport.deltaMB)
      .metric('fdBefore', fdBefore)
      .metric('fdAfter', fdAfter)
      .metric('healthyClientPatches', healthyFrames);

    const p95ok = pct.p95 != null && pct.p95 <= 300;
    const pass = p95ok && drained;
    r.setPass(pass);
    if (pass) {
      r.note(`p95 ${pct.p95}ms ≤ 300ms; live set drained to 0; RSS Δ ${rssReport.deltaMB}MB (documented)`);
    } else {
      if (!p95ok) r.note(`broadcast latency p95 ${pct.p95}ms exceeded 300ms bar`);
      if (!drained) r.note('live set did not drain to 0 after churn (possible timer leak)');
    }
    if (rssReport.deltaMB > 150) r.note(`RSS grew ${rssReport.deltaMB}MB during churn — review`);
    return r;
  } finally {
    await closeSwarm(swarm);
    await srv.close();
  }
}

module.exports = { run };
