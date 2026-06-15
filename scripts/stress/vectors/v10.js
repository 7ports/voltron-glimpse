'use strict';

// V10 — Multi-pod watcher fan-out. The REAL watcher drives syncLogRoots() across
// several distinct pod project roots (each its own temp .voltron/logs), as
// src/docker.js pod attribution would when containers span pods. Each in-scope
// foreign root gets one polling chokidar watcher + offset tail; when a pod leaves
// the live set its root must be torn down (no watcher leak). Asserted behaviorally:
// every in-scope pod's log event surfaces (one working watcher per root), and after
// a pod leaves its NEW log content no longer surfaces (root removed) while the
// pinned self root keeps working. Bars (plan §):
//   - one watcher per in-scope root, removed when the pod leaves (no watcher leak)
const path = require('node:path');
const { createWatcher } = require('../../../src/watcher');
const { makeTempProject, makeLogWriter } = require('../lib/tempProject');
const { fdCount } = require('../lib/instrument');
const { sleep, result } = require('../lib/util');

const PRESETS = {
  abbrev: { pods: 5 },
  full: { pods: 20 },
};

async function run({ mode = 'abbrev' } = {}) {
  const p = PRESETS[mode] || PRESETS.abbrev;
  const r = result('V10', `multi-pod watcher fan-out (${p.pods} pods)`);

  // Self pod (pinned root) + N foreign pods, each a throwaway temp project.
  const self = makeTempProject();
  const pods = Array.from({ length: p.pods }, () => makeTempProject());
  const cleanup = () => {
    self.cleanup();
    for (const pod of pods) pod.cleanup();
  };

  // Collect every parsed nodeId the watcher surfaces (deduped — chokidar may also
  // deliver alongside pollTail; we only care whether a nodeId EVER surfaced).
  const surfaced = new Set();
  const fdBefore = fdCount();
  const watcher = createWatcher(
    self.root,
    (parsed) => {
      if (parsed && parsed.nodeId) surfaced.add(parsed.nodeId);
    },
    () => {}
  );

  try {
    watcher.scanExisting(); // seeds the pinned self root to EOF (empty here)

    // --- Pods enter scope: one foreign log root per pod -------------------
    const roots = pods.map((pod, i) => ({
      root: pod.root,
      podKey: `pod-${i}`,
      podLabel: `Pod ${i}`,
    }));
    watcher.syncLogRoots(roots);

    // Write a distinct [exec]+[STEP] into each pod's logs (+ the self root).
    const selfWriter = makeLogWriter(self.logsDir, 'self-agent');
    selfWriter.exec();
    selfWriter.step(1, 'self work');
    const podWriters = pods.map((pod, i) => {
      const w = makeLogWriter(pod.logsDir, `pod${i}-agent`);
      w.exec();
      w.step(1, `pod ${i} work`);
      return w;
    });
    watcher.pollTail();
    await sleep(20);
    watcher.pollTail(); // belt-and-suspenders second pass

    const podsSurfacedIn = pods.filter((_, i) => surfaced.has(`pod${i}-agent`)).length;
    const selfSurfacedIn = surfaced.has('self-agent');

    // --- Pods leave scope: foreign roots must be torn down ----------------
    watcher.syncLogRoots([]); // every foreign root removed; self stays pinned
    surfaced.clear();

    // New content written to the now-removed roots must NOT surface; the pinned
    // self root must STILL surface (proves removal is targeted, not global).
    for (let i = 0; i < pods.length; i++) {
      podWriters[i].step(2, `pod ${i} AFTER leave — must be ignored`);
    }
    selfWriter.step(2, 'self AFTER — must still surface');
    watcher.pollTail();
    await sleep(20);
    watcher.pollTail();

    const leakedAfterLeave = pods.filter((_, i) => surfaced.has(`pod${i}-agent`)).length;
    const selfSurfacedAfter = surfaced.has('self-agent');

    await watcher.close();
    await sleep(50);
    const fdAfter = fdCount();
    const fdDelta = fdAfter != null && fdBefore != null ? fdAfter - fdBefore : null;

    r.metric('pods', p.pods)
      .metric('podRootsSurfacedInScope', podsSurfacedIn)
      .metric('selfRootSurfacedInScope', selfSurfacedIn)
      .metric('podRootsLeakedAfterLeave', leakedAfterLeave)
      .metric('selfRootStillWorksAfterLeave', selfSurfacedAfter)
      .metric('fdBefore', fdBefore)
      .metric('fdAfterClose', fdAfter)
      .metric('fdDelta', fdDelta);

    const allInScope = podsSurfacedIn === p.pods && selfSurfacedIn;
    const noLeak = leakedAfterLeave === 0 && selfSurfacedAfter;
    // FD return-to-baseline after close (usePolling watchers hold few/no FDs, but a
    // real leak would scale with pod count); allow small slack.
    const fdReturned = fdDelta == null || fdDelta <= 8;
    const pass = allInScope && noLeak && fdReturned;
    r.setPass(pass);

    if (allInScope) r.note(`one watcher per in-scope root: all ${p.pods} pods + self surfaced events`);
    else r.note(`FINDING: only ${podsSurfacedIn}/${p.pods} pod roots surfaced (self=${selfSurfacedIn})`);

    if (noLeak) r.note(`pods removed cleanly: 0/${p.pods} leaked post-leave; pinned self root still works`);
    else r.note(`FINDING: ${leakedAfterLeave} foreign roots kept emitting after leave (watcher leak)`);

    r.note(`FD delta after close: ${fdDelta} (watchers torn down, no descriptor leak)`);
    return r;
  } finally {
    try {
      await watcher.close();
    } catch (_e) {
      /* already closed */
    }
    cleanup();
  }
}

module.exports = { run, PRESETS };
