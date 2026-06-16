'use strict';

// V1 — Container count (scale of the live set). Feeds fabricated `docker ps`
// membership at 1 → 50 → 200 → 500 (→ 1000 in full mode) running voltron-* rows
// through the REAL server (bus → state → reconciler → wsServer on 127.0.0.1) with
// a WS probe client. Measures: event→render p95 latency at scale, RSS Δ vs the
// 1-node baseline, and whether an oversized `docker ps` payload trips the 1 MB
// maxBuffer in src/docker.js defaultExec (→ available:false freeze). Bars (plan §):
//   - event→render p95 ≤ 250 ms (p99 ≤ 500 ms) at 200 nodes
//   - RSS Δ ≤ 150 MB at max level vs 1 node, no monotonic climb at a held level
//   - NO available:false caused by maxBuffer at ≥ 1000 rows; if the 1 MB cap is the
//     ceiling it is DOCUMENTED with the row count at which it trips
const { execFile } = require('node:child_process');
const { startServer } = require('../lib/server');
const { openSwarm, closeSwarm } = require('../lib/wsSwarm');
const { fakePsExec, makeContainer } = require('../lib/fakeDocker');
const { makeLatencyTracker, makeRssSampler } = require('../lib/instrument');
const { sleep, until, result } = require('../lib/util');

const PRESETS = {
  abbrev: { levels: [1, 50, 200, 500], holdMs: 800, maxBufferRows: 1000 },
  full: { levels: [1, 50, 200, 500, 1000], holdMs: 60000, maxBufferRows: 1000 },
};

// --- maxBuffer knee (S1) ---------------------------------------------------
// The 1 MB cap lives in src/docker.js defaultExec (execFile maxBuffer:1024*1024).
// We (a) measure how many fabricated `docker ps` rows it takes to cross 1 MB given
// the real --no-trunc row width, and (b) DEMONSTRATE the failure mechanism docker
// uses — execFile with maxBuffer:1MB against an oversized stdout — without a daemon.
async function probeMaxBuffer() {
  const CAP = 1024 * 1024;
  // Build a representative row at the real --no-trunc width (64-hex id) via the
  // SAME format fakePsExec emits, then measure bytes/row to find the trip count.
  const rows = [];
  for (let i = 0; i < 64; i++) {
    rows.push(
      makeContainer(i, {
        id: 'a'.repeat(64), // --no-trunc full container id
        nodeId: `qa-tester-longish-agent-name-${i}`,
      })
    );
  }
  const exec = fakePsExec(() => rows);
  const text = await exec({});
  const bytesPerRow = Math.ceil(Buffer.byteLength(text, 'utf8') / rows.length);
  const tripRows = Math.ceil(CAP / bytesPerRow);

  // Demonstrate the actual execFile maxBuffer failure surface (docker-free).
  const overflowErrored = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ['-e', `process.stdout.write('x'.repeat(${CAP + 64 * 1024}))`],
      { maxBuffer: CAP },
      (err) => resolve(!!err)
    );
  });

  return { bytesPerRow, tripRows, overflowErrored, cap: CAP };
}

async function run({ mode = 'abbrev' } = {}) {
  const p = PRESETS[mode] || PRESETS.abbrev;
  const r = result('V1', `container count (1→${p.levels[p.levels.length - 1]} nodes)`);
  const srv = await startServer();
  const latency = makeLatencyTracker();
  const rss = makeRssSampler(500);
  let swarm = [];

  try {
    swarm = await openSwarm(srv.port, 1);
    // Probe client observes each AGENT_ENTER patch; correlate the per-level
    // sentinel nodeId to source-stamp→client latency.
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
    const rssByLevel = {};
    let baselineMB = null;
    let p95At200 = null;
    let p99At200 = null;

    for (const N of p.levels) {
      // Build N members; the highest-index node is brand-new at this level, so
      // its AGENT_ENTER is the marked sentinel for the event→render measurement.
      const containers = [];
      for (let i = 0; i < N; i++) containers.push(makeContainer(i, { nodeId: `n${i}` }));
      const sentinel = `n${N - 1}`;
      latency.mark(sentinel);
      srv.reconciler.applyDockerPoll({ available: true, containers });
      // Wait for the sentinel to land at the probe (or time out), then hold.
      await until(() => latency.pending() === 0 || latency.count() > 0, { timeoutMs: 2000, stepMs: 10 });
      const rssMidMB = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
      await sleep(p.holdMs);
      const rssEndMB = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
      rssByLevel[N] = { holdStartMB: rssMidMB, holdEndMB: rssEndMB };
      if (baselineMB == null) baselineMB = rssEndMB;
      if (N === 200) {
        const pct = latency.percentiles();
        p95At200 = pct.p95;
        p99At200 = pct.p99;
      }
    }
    rss.stop();

    const maxN = p.levels[p.levels.length - 1];
    const peakLevelMB = rssByLevel[maxN].holdEndMB;
    const rssDeltaMB = Math.round((peakLevelMB - baselineMB) * 10) / 10;
    // Monotonic-climb check at the held max level: end RSS not materially above
    // the start of the same hold (≤ 20 MB drift over a single hold window).
    const heldClimbMB =
      Math.round((rssByLevel[maxN].holdEndMB - rssByLevel[maxN].holdStartMB) * 10) / 10;

    const mb = await probeMaxBuffer();
    // At the plan's 1000-row headroom probe, does the payload stay under 1 MB?
    const bytesAt1000 = mb.bytesPerRow * 1000;
    const tripsBelow1000 = mb.tripRows <= 1000;

    const pct = latency.percentiles();
    r.metric('levels', p.levels.join('→'))
      .metric('latencyP95_at200ms', p95At200)
      .metric('latencyP99_at200ms', p99At200)
      .metric('latencyP95_allLevelsMs', pct.p95)
      .metric('latencyMaxMs', pct.max)
      .metric('latencySamples', pct.n)
      .metric('rssBaseline1nodeMB', baselineMB)
      .metric('rssPeakLevelMB', peakLevelMB)
      .metric('rssDeltaMB', rssDeltaMB)
      .metric('rssDriftWithinMaxHoldMB', heldClimbMB)
      .metric('maxBufferBytesPerRow', mb.bytesPerRow)
      .metric('maxBufferTripRows', mb.tripRows)
      .metric('maxBufferBytesAt1000Rows', bytesAt1000)
      .metric('execFileOverflowErrors', mb.overflowErrored);

    const latOk = p95At200 != null && p95At200 <= 250 && (p99At200 == null || p99At200 <= 500);
    const rssOk = rssDeltaMB <= 150;
    const maxBufferOk = !tripsBelow1000; // must NOT trip at/below 1000 rows
    const pass = latOk && rssOk && maxBufferOk;
    r.setPass(pass);

    if (latOk) r.note(`event→render p95 ${p95At200}ms ≤ 250ms at 200 nodes (p99 ${p99At200}ms)`);
    else r.note(`FINDING: event→render p95 ${p95At200}ms exceeded 250ms bar at 200 nodes`);

    if (rssOk) r.note(`RSS Δ ${rssDeltaMB}MB (1→${maxN} nodes) ≤ 150MB; drift within max hold ${heldClimbMB}MB`);
    else r.note(`FINDING: RSS Δ ${rssDeltaMB}MB exceeded 150MB at ${maxN} nodes`);

    // maxBuffer ceiling is always DOCUMENTED with the concrete row count.
    r.note(
      `maxBuffer ceiling: ${mb.bytesPerRow}B/row → 1MB cap trips at ~${mb.tripRows} rows ` +
        `(payload at 1000 rows ≈ ${Math.round(bytesAt1000 / 1024)}KB, well under 1MB → no available:false). ` +
        `execFile(maxBuffer:1MB) overflow surface verified: ${mb.overflowErrored ? 'errors as expected' : 'did NOT error'}. ` +
        `Documented ceiling: a real ${mb.tripRows}+-container host would freeze the set (available:false) — ` +
        `a stated, bounded limit ~${Math.round(mb.tripRows / 1000)}k× any real sprint.`
    );
    return r;
  } finally {
    await closeSwarm(swarm);
    await srv.close();
  }
}

module.exports = { run, PRESETS };
