'use strict';

// V6-short — WS slow-consumer / backpressure. 10 clients; 3 pause their receive
// side (dead consumers) while ~5000 AGENT_UPDATE frames are pushed. safeSend has
// no bufferedAmount guard (wsServer.js:6), so dead consumers buffer server-side.
// Bars (plan §): server RSS growth bounded (or documented with the rate); healthy
// clients keep receiving (no starvation).
const { startServer } = require('../lib/server');
const { openSwarm, closeSwarm } = require('../lib/wsSwarm');
const { makeContainer } = require('../lib/fakeDocker');
const { makeRssSampler, fdCount } = require('../lib/instrument');
const { sleep, until, result } = require('../lib/util');

async function run({ clients = 10, deadCount = 3, updates = 5000, batch = 500 } = {}) {
  const r = result('V6', 'WS backpressure (3 dead consumers, ~5000 updates)');
  const srv = await startServer();
  const rss = makeRssSampler(500);
  const fdBefore = fdCount();
  let swarm = [];

  try {
    swarm = await openSwarm(srv.port, clients);
    await sleep(50); // ensure snapshots delivered, _socket settled

    // Bring one live node up so AGENT_UPDATE has a target.
    srv.reconciler.applyDockerPoll({ available: true, containers: [makeContainer(0, { nodeId: 'bp' })] });
    await sleep(20);

    // Pause the receive side of the dead consumers — server-side bufferedAmount
    // for them will climb (no backpressure guard).
    const dead = swarm.slice(0, deadCount);
    const healthy = swarm.slice(deadCount);
    for (const c of dead) c.pause();

    function sampleServerBuffered() {
      let total = 0;
      for (const c of srv.wsServer.wss.clients) total += c.bufferedAmount || 0;
      return total;
    }

    rss.start();
    // Push ~5000 updates in batches, yielding so healthy clients drain concurrently.
    // Sample server-side bufferedAmount each batch to capture the transient
    // dead-consumer backpressure (kernel socket buffers may absorb small frames
    // before the JS-layer ws buffer ever grows — so peak, not final, is the signal).
    let peakServerBuffered = 0;
    for (let i = 0; i < updates; i++) {
      srv.reconciler.applyLogEvent({
        nodeId: 'bp',
        state: 'working',
        exitCode: null,
        latestStep: `[STEP ${i}] push`,
        stepNum: i,
        steps: [{ stepNum: i, text: `[STEP ${i}] push` }],
      });
      if (i % batch === batch - 1) {
        const b = sampleServerBuffered();
        if (b > peakServerBuffered) peakServerBuffered = b;
        await sleep(0);
      }
    }

    // Sentinel: a final distinctive update. Healthy clients must receive it.
    const SENTINEL = 'SENTINEL-FINAL';
    srv.reconciler.applyLogEvent({
      nodeId: 'bp',
      state: 'working',
      exitCode: null,
      latestStep: `[STEP] ${SENTINEL}`,
      steps: [{ stepNum: null, text: `[STEP] ${SENTINEL}` }],
    });

    const healthyGotSentinel = await until(
      () =>
        healthy.every(
          (c) =>
            c.lastMessage &&
            c.lastMessage.type === 'patch' &&
            c.lastMessage.payload &&
            typeof c.lastMessage.payload.step === 'string' &&
            c.lastMessage.payload.step.includes(SENTINEL)
        ),
      { timeoutMs: 5000, stepMs: 25 }
    );
    rss.stop();

    // Server-side per-client buffering after drain (kernel may have absorbed it).
    const serverBuffered = sampleServerBuffered();
    const rssReport = rss.report();
    const healthyMin = Math.min(...healthy.map((c) => c.patches));
    const deadMax = Math.max(...dead.map((c) => c.patches));
    const fdAfter = fdCount();

    r.metric('updatesPushed', updates)
      .metric('healthyGotSentinel', healthyGotSentinel)
      .metric('healthyClientMinPatches', healthyMin)
      .metric('deadClientMaxPatches', deadMax)
      .metric('serverSideBufferedPeakBytes', peakServerBuffered)
      .metric('serverSideBufferedFinalBytes', serverBuffered)
      .metric('rssBaselineMB', rssReport.baselineMB)
      .metric('rssPeakMB', rssReport.peakMB)
      .metric('rssDeltaMB', rssReport.deltaMB)
      .metric('fdBefore', fdBefore)
      .metric('fdAfter', fdAfter);

    // RSS bound: a few-MB buffer for 3 dead consumers × 5000 small frames is
    // expected; flag only an unbounded balloon (> 250 MB for this short burst).
    const rssBounded = rssReport.deltaMB <= 250;
    const noStarvation = healthyGotSentinel && healthyMin > 0;
    const pass = noStarvation && rssBounded;
    r.setPass(pass);
    if (pass) {
      r.note(
        `healthy clients kept receiving (min ${healthyMin} patches vs dead ${deadMax}); ` +
          `dead-consumer buffering peaked ${peakServerBuffered}B server-side; RSS Δ ${rssReport.deltaMB}MB (bounded)`
      );
    } else {
      if (!noStarvation) r.note('healthy clients were starved (did not receive sentinel)');
      if (!rssBounded) r.note(`server RSS ballooned ${rssReport.deltaMB}MB — unbounded buffering`);
    }
    r.note(
      `DOCUMENTED: safeSend has no bufferedAmount guard — dead-consumer buffering grows with push volume ` +
        `(peak ${peakServerBuffered}B at ${updates} small frames; small bounded payloads are absorbed by kernel socket buffers, ` +
        `so RSS stays bounded — the unbounded-balloon risk surfaces with larger or many-more frames)`
    );
    return r;
  } finally {
    for (const c of swarm) {
      try {
        c.resume();
      } catch (_e) {
        /* ignore */
      }
    }
    await closeSwarm(swarm);
    await srv.close();
  }
}

module.exports = { run };
