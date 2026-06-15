'use strict';

// V9 — Reconciler timer pressure under churn (fake clock, deterministic).
// Drive enter→exit faster than the 2.5 s linger so hundreds of linger timers
// overlap, then drain. Bars (plan §Pass/fail):
//   - every entered node emits exactly ONE AGENT_EXIT (idempotent wind-down)
//   - zero orphaned timers after drain (fake clock size() == 0)
//   - deterministic (no wall-clock, no flakiness)
const { createReconciler } = require('../../../src/liveness');
const { createEventBus, EVENTS } = require('../../../src/eventBus');
const { makeFakeClock } = require('../lib/fakeClock');
const { makeContainer } = require('../lib/fakeDocker');
const { result } = require('../lib/util');

function run({ rounds = 300, stepMs = 10, lingerMs = 2500 } = {}) {
  const r = result('V9', 'reconciler timer pressure (fake clock)');
  const clock = makeFakeClock();
  const bus = createEventBus();

  const enters = [];
  const exits = [];
  bus.on(EVENTS.AGENT_ENTER, (p) => enters.push(p.nodeId));
  bus.on(EVENTS.AGENT_EXIT, (p) => exits.push(p.nodeId));

  const reconciler = createReconciler({ bus, timer: clock, lingerMs, erroredLingerMs: lingerMs });

  let maxOverlap = 0;
  // Each round: a brand-new container is the sole member, which drops the
  // previous round's container (absent → handleExit schedules a linger timer).
  // We advance only stepMs (< lingerMs) so timers pile up unfired.
  for (let i = 0; i < rounds; i++) {
    reconciler.applyDockerPoll({ available: true, containers: [makeContainer(i)] });
    clock.advance(stepMs);
    if (clock.size() > maxOverlap) maxOverlap = clock.size();
  }
  // Drop the final member and drain every linger timer.
  reconciler.applyDockerPoll({ available: true, containers: [] });
  clock.advance(lingerMs * 2);

  const orphanTimers = clock.size();
  const liveLeft = reconciler.snapshot().liveAgents.length;
  const dupExits = exits.length - new Set(exits).size;
  const everyEnterExitedOnce =
    enters.length === rounds &&
    exits.length === rounds &&
    dupExits === 0 &&
    new Set(exits).size === new Set(enters).size;

  r.metric('rounds', rounds)
    .metric('maxOverlappingTimers', maxOverlap)
    .metric('enters', enters.length)
    .metric('exits', exits.length)
    .metric('duplicateExits', dupExits)
    .metric('orphanTimersAfterDrain', orphanTimers)
    .metric('liveAgentsAfterDrain', liveLeft);

  const pass = everyEnterExitedOnce && orphanTimers === 0 && liveLeft === 0;
  r.setPass(pass);
  if (!pass) {
    if (!everyEnterExitedOnce) r.note('enter/exit accounting mismatch (not exactly one exit per enter)');
    if (orphanTimers !== 0) r.note(`${orphanTimers} orphaned linger timers after drain`);
    if (liveLeft !== 0) r.note(`${liveLeft} agents still live after drain`);
  } else {
    r.note(`${maxOverlap} linger timers overlapped at peak, all drained to 0`);
  }
  return r;
}

module.exports = { run };
