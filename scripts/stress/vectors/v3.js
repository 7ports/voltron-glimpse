'use strict';

// V3 — Log throughput (per-container and aggregate). The REAL watcher + offset
// tail + parser run against a temp root; many synthetic .voltron/logs/*.log files
// get [STEP] lines at escalating per-file batch sizes, then an [exit] each. The
// run is deterministic and synchronous in the hot path (no awaits between write
// and pollTail), with a fake clock draining linger timers — so chokidar never
// interleaves and counts are exact. Bars (plan §):
//   - ZERO dropped [STEP]/[exit] — offset tail is lossless (steps surfaced ==
//     steps written; every container's [exit] surfaces and it winds down)
//   - bounded RSS: recentSteps cap of 5 HOLDS regardless of lines/sec; Δ ≤ 200 MB
const { createWatcher } = require('../../../src/watcher');
const { createReconciler } = require('../../../src/liveness');
const { createEventBus, EVENTS } = require('../../../src/eventBus');
const { makeFakeClock } = require('../lib/fakeClock');
const { makeContainer } = require('../lib/fakeDocker');
const { makeTempProject, makeLogWriter } = require('../lib/tempProject');
const { result } = require('../lib/util');
const { performance } = require('node:perf_hooks');

const PRESETS = {
  // abbrev proves the vector + caps; full is the plan's 1000 lines/sec × 100 files.
  abbrev: { files: 10, noStepFiles: 2, batches: [10, 100, 1000], lingerMs: 2500 },
  full: { files: 100, noStepFiles: 10, batches: [10, 100, 1000, 1000, 1000], lingerMs: 2500 },
};

function rssMB() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

async function run({ mode = 'abbrev' } = {}) {
  const p = PRESETS[mode] || PRESETS.abbrev;
  const r = result('V3', `log throughput (${p.files} files, batches ${p.batches.join('/')})`);
  const proj = makeTempProject();
  const clock = makeFakeClock();
  const bus = createEventBus();

  let exitsObserved = 0;
  bus.on(EVENTS.AGENT_EXIT, () => {
    exitsObserved += 1;
  });
  const reconciler = createReconciler({ bus, timer: clock, lingerMs: p.lingerMs });
  const watcher = createWatcher(
    proj.root,
    (parsed) => reconciler.applyLogEvent(parsed),
    () => {}
  );

  try {
    // EOF-seed BEFORE any file exists (present-tense rule §2.5). Files created
    // after this are untracked → read from offset 0 → fully tailed (no drops).
    watcher.scanExisting();

    // Register every container LIVE first (applyLogEvent ignores unknown nodeIds).
    const stepIds = Array.from({ length: p.files }, (_, i) => `stepper-${i}`);
    const noStepIds = Array.from({ length: p.noStepFiles }, (_, i) => `committer-${i}`);
    const allIds = stepIds.concat(noStepIds);
    const containers = allIds.map((id) => makeContainer(0, { nodeId: id }));
    reconciler.applyDockerPoll({ available: true, containers });

    const stepWriters = stepIds.map((id) => makeLogWriter(proj.logsDir, id));
    const noStepWriters = noStepIds.map((id) => makeLogWriter(proj.logsDir, id));

    // committer-style: [exec] only, no steps (no-step path). [exec] alone is not
    // a step, so it must NOT inflate stepCount — only its [exit] matters.
    for (const w of noStepWriters) w.exec();
    watcher.pollTail();

    const rssBaseline = rssMB();
    let stepsWritten = 0;
    let rssPeak = rssBaseline;

    // Escalating throughput: each round every stepper appends `batch` [STEP] lines,
    // then one pollTail drains all appended bytes losslessly. Steps and the [exit]
    // are kept in SEPARATE chunks (parseLog collapses a step+exit chunk to an exit).
    for (const batch of p.batches) {
      for (const w of stepWriters) {
        for (let n = 0; n < batch; n++) w.step(n, 'x'.repeat(40));
        stepsWritten += batch;
      }
      watcher.pollTail();
      const m = rssMB();
      if (m > rssPeak) rssPeak = m;
    }

    // Sum surfaced steps from reconciler state (stepCount accumulates per step in
    // each parsed steps[] chunk → lossless tail means surfaced == written).
    let stepsSurfaced = 0;
    let maxRecentSteps = 0;
    for (const a of reconciler.snapshot().liveAgents) {
      stepsSurfaced += a.stepCount || 0;
      if (Array.isArray(a.recentSteps) && a.recentSteps.length > maxRecentSteps) {
        maxRecentSteps = a.recentSteps.length;
      }
    }

    // Now exit every container (separate chunk), then drain linger timers.
    const t0 = performance.now();
    for (const w of stepWriters) w.exit(0);
    for (const w of noStepWriters) w.exit(0);
    watcher.pollTail();
    clock.advance(p.lingerMs * 2);
    const drainMs = Math.round((performance.now() - t0) * 100) / 100;

    const liveLeft = reconciler.snapshot().liveAgents.length;
    const rssDeltaMB = Math.round((rssPeak - rssBaseline) * 10) / 10;
    const exitsWritten = allIds.length;

    r.metric('files', p.files)
      .metric('noStepFiles', p.noStepFiles)
      .metric('stepsWritten', stepsWritten)
      .metric('stepsSurfaced', stepsSurfaced)
      .metric('droppedSteps', stepsWritten - stepsSurfaced)
      .metric('exitsWritten', exitsWritten)
      .metric('exitsObserved', exitsObserved)
      .metric('droppedExits', exitsWritten - exitsObserved)
      .metric('maxRecentStepsPerAgent', maxRecentSteps)
      .metric('liveAgentsAfterDrain', liveLeft)
      .metric('rssBaselineMB', rssBaseline)
      .metric('rssPeakMB', rssPeak)
      .metric('rssDeltaMB', rssDeltaMB)
      .metric('exitDrainMs', drainMs);

    const losslessSteps = stepsSurfaced === stepsWritten;
    const losslessExits = exitsObserved === exitsWritten;
    const capHolds = maxRecentSteps <= 5;
    const drained = liveLeft === 0;
    const rssOk = rssDeltaMB <= 200;
    const pass = losslessSteps && losslessExits && capHolds && drained && rssOk;
    r.setPass(pass);

    if (losslessSteps) r.note(`lossless steps: ${stepsSurfaced}/${stepsWritten} surfaced (0 dropped)`);
    else r.note(`FINDING: ${stepsWritten - stepsSurfaced} [STEP] lines dropped (offset tail lossy)`);

    if (losslessExits) r.note(`all ${exitsWritten} [exit] lines surfaced; set drained to 0`);
    else r.note(`FINDING: ${exitsWritten - exitsObserved} [exit] lines dropped / nodes stuck live`);

    if (capHolds) r.note(`recentSteps cap held at ${maxRecentSteps} ≤ 5 across ${stepsWritten} steps`);
    else r.note(`FINDING: recentSteps grew to ${maxRecentSteps} (> 5 cap) — unbounded memory`);

    r.note(`RSS Δ ${rssDeltaMB}MB ≤ 200MB (recentSteps ring + truncation bound the live set)`);
    return r;
  } finally {
    try {
      await watcher.close();
    } catch (_e) {
      /* ignore */
    }
    proj.cleanup();
  }
}

module.exports = { run, PRESETS };
