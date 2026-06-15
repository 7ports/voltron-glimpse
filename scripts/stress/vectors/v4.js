'use strict';

// V4 — Log rotation / truncation (correctness probe, S3 offset logic). Uses the
// REAL watcher + parser against a temp root, honoring the EOF-seeding asymmetry
// the plan flags: start (scanExisting) FIRST, then write, else post-start appends
// are under-counted. Bars (plan §Pass/fail):
//   - never a stuck-live node after a rotate/truncate
//   - the post-rotation [exit] surfaces, OR the node exits anyway (Docker-drop
//     backstop) — any bounded loss of the log [exit] is documented, not silent
const path = require('node:path');
const { createWatcher } = require('../../../src/watcher');
const { createReconciler } = require('../../../src/liveness');
const { createEventBus, EVENTS } = require('../../../src/eventBus');
const { makeFakeClock } = require('../lib/fakeClock');
const { makeContainer } = require('../lib/fakeDocker');
const { makeTempProject, makeLogWriter } = require('../lib/tempProject');
const { result } = require('../lib/util');

async function run({ lingerMs = 2500 } = {}) {
  const r = result('V4', 'log rotation / truncation (offset correctness)');
  const proj = makeTempProject();
  const clock = makeFakeClock();
  const bus = createEventBus();

  const logEvents = [];
  bus.on(EVENTS.AGENT_EXIT, () => {});
  const reconciler = createReconciler({ bus, timer: clock, lingerMs });

  const watcher = createWatcher(
    proj.root,
    (parsed) => {
      logEvents.push(parsed);
      reconciler.applyLogEvent(parsed);
    },
    () => {}
  );

  // Membership helper: keep an authoritative docker set; the reconciler diffs it.
  let members = [];
  function setMembers(ids) {
    members = ids.map((id) => makeContainer(0, { nodeId: id }));
    reconciler.applyDockerPoll({ available: true, containers: members });
  }
  const stateOf = (id) => {
    const a = reconciler.snapshot().liveAgents.find((x) => x.nodeId === id);
    return a ? a.state : null;
  };
  const isLive = (id) => reconciler.snapshot().liveAgents.some((x) => x.nodeId === id);

  try {
    // --- EOF-seeding asymmetry (start-then-write) -------------------------
    // Pre-write history BEFORE scanExisting; the self log root seeds to EOF, so
    // this history must NOT be replayed (present-tense rule §2.5).
    const wEof = makeLogWriter(proj.logsDir, 'eof');
    wEof.exec();
    wEof.step(99, 'pre-start history that must be ignored');
    watcher.scanExisting(); // seed self log root + journal to EOF
    setMembers(['eof']);
    logEvents.length = 0;
    watcher.pollTail();
    const historyReplayed = logEvents.some((e) => e.nodeId === 'eof');
    // A post-start append MUST surface.
    wEof.step(1, 'post-start-marker');
    watcher.pollTail();
    const postStartSurfaced = logEvents.some(
      (e) => e.nodeId === 'eof' && e.latestStep && e.latestStep.includes('post-start-marker')
    );

    // --- Control: normal append exit (no rotation) must surface ----------
    const wCtl = makeLogWriter(proj.logsDir, 'control');
    setMembers(['eof', 'control']);
    wCtl.exec();
    wCtl.step(1, 'go');
    watcher.pollTail();
    const ctlWorking = stateOf('control') === 'working';
    wCtl.exit(0);
    watcher.pollTail();
    const ctlExitSurfaced = stateOf('control') === 'exiting:done';

    // --- Case A: rename + recreate, ~10× ----------------------------------
    let renameExitSurfaced = 0;
    const wA = makeLogWriter(proj.logsDir, 'rename');
    setMembers(['eof', 'control', 'rename']);
    wA.exec();
    wA.step(1, 'busy');
    watcher.pollTail();
    for (let i = 0; i < 10; i++) {
      const before = stateOf('rename');
      wA.rotateRename(i + 1); // x.log -> x.<i>.log, fresh empty x.log
      wA.step(2, 'post-rotate work');
      wA.exit(0); // exit written to the fresh (small) current log
      watcher.pollTail();
      if (stateOf('rename') === 'exiting:done' && before !== 'exiting:done') renameExitSurfaced++;
      // reset for the next iteration only if it didn't exit (so we keep probing)
      if (stateOf('rename') !== 'exiting:done') {
        // still working — fine, next rotate keeps testing
      } else {
        break; // surfaced once → enough
      }
    }

    // --- Case B: truncate-in-place, ~10× ----------------------------------
    let truncExitSurfaced = 0;
    const wB = makeLogWriter(proj.logsDir, 'trunc');
    setMembers(['eof', 'control', 'rename', 'trunc']);
    wB.exec();
    wB.step(1, 'busy');
    watcher.pollTail();
    for (let i = 0; i < 10; i++) {
      wB.truncate(); // size -> 0 (defeats offset tracking when offset > new size)
      wB.exit(0);
      watcher.pollTail();
      if (stateOf('trunc') === 'exiting:done') {
        truncExitSurfaced++;
        break;
      }
    }

    // --- Backstop: Docker-drop must wind every node down (never stuck) ----
    setMembers([]); // all containers gone from docker
    clock.advance(lingerMs * 2);
    const stuck = ['eof', 'control', 'rename', 'trunc'].filter((id) => isLive(id));

    r.metric('historyReplayed', historyReplayed)
      .metric('postStartSurfaced', postStartSurfaced)
      .metric('controlWorking', ctlWorking)
      .metric('controlExitSurfacedViaLog', ctlExitSurfaced)
      .metric('renameExitSurfacedViaLog', renameExitSurfaced > 0)
      .metric('truncExitSurfacedViaLog', truncExitSurfaced > 0)
      .metric('stuckLiveNodes', stuck.length);

    const pass =
      historyReplayed === false &&
      postStartSurfaced === true &&
      ctlWorking === true &&
      ctlExitSurfaced === true &&
      stuck.length === 0;

    r.setPass(pass);
    if (pass) {
      r.note('EOF seeding honored; control exit surfaced; no stuck-live node after rotate/truncate');
    } else {
      if (historyReplayed) r.note('pre-start history was replayed (EOF seeding violated)');
      if (!postStartSurfaced) r.note('post-start append did not surface (harness wiring)');
      if (!ctlExitSurfaced) r.note('control [exit] not delivered (offset tail broken)');
      if (stuck.length) r.note(`stuck-live nodes after rotate/truncate: ${stuck.join(', ')}`);
    }
    // Document the offset-asymmetry bounded loss honestly.
    if (renameExitSurfaced === 0)
      r.note(
        'DOCUMENTED: post-rename [exit] not delivered via offset tail (new inode < tracked offset) — recovered by Docker-drop backstop'
      );
    if (truncExitSurfaced === 0)
      r.note(
        'DOCUMENTED: post-truncate [exit] not delivered via offset tail (new size < tracked offset) — recovered by Docker-drop backstop'
      );
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

module.exports = { run };
