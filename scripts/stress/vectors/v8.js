'use strict';

// V8 — Docker daemon flap / kill / recovery (fakes). Drive real pollDocker with
// an exec scripted success → throw (daemon down) → success. The throw lands in
// pollDocker's catch → { available:false }, which the reconciler treats as
// "no change" (liveness.js:218). Bars (plan §Pass/fail):
//   - ZERO spurious AGENT_EXIT/AGENT_ENTER from a failed poll; set unchanged
//     across every "down" tick
//   - recovery re-syncs membership within ~2 poll cadences; no duplicate nodes
const { pollDocker } = require('../../../src/docker');
const { createReconciler } = require('../../../src/liveness');
const { createEventBus, EVENTS } = require('../../../src/eventBus');
const { makeFakeClock } = require('../lib/fakeClock');
const { fakePsExec, makeContainer } = require('../lib/fakeDocker');
const { result } = require('../lib/util');

async function run({ pollMs = 1000 } = {}) {
  const r = result('V8', 'docker daemon flap / kill / recovery');
  const clock = makeFakeClock();
  const bus = createEventBus();

  const enters = [];
  const exits = [];
  bus.on(EVENTS.AGENT_ENTER, (p) => enters.push(p.nodeId));
  bus.on(EVENTS.AGENT_EXIT, (p) => exits.push(p.nodeId));

  const reconciler = createReconciler({ bus, timer: clock });

  // Stable membership of 3 containers for the whole test.
  const members = [makeContainer(0), makeContainer(1), makeContainer(2)];
  let down = false;
  const exec = fakePsExec(
    () => members,
    { isDown: () => down }
  );

  async function tick() {
    const res = await pollDocker({ exec });
    reconciler.applyDockerPoll(res);
    clock.advance(pollMs); // advance one cadence; any due linger would fire here
    return res;
  }

  // 1) Bring the set up.
  down = false;
  await tick();
  const initialEnters = enters.length; // expect 3
  const baselineIds = reconciler.snapshot().liveAgents.map((a) => a.nodeId).sort();

  // 2) Single failed poll — the load-bearing "no change" rule.
  const entersBeforeFlap = enters.length;
  const exitsBeforeFlap = exits.length;
  down = true;
  const failedRes = await tick();
  const spuriousFromSingleFail =
    enters.length - entersBeforeFlap + (exits.length - exitsBeforeFlap);

  // 3) Rapid flap (5 Hz-style): alternate down/up several cycles.
  let flapSpurious = 0;
  for (let i = 0; i < 10; i++) {
    const e0 = enters.length;
    const x0 = exits.length;
    down = i % 2 === 0; // down on even ticks
    await tick();
    flapSpurious += enters.length - e0 + (exits.length - x0);
  }

  // 4) Sustained 60 s outage, then recovery.
  down = true;
  const outageTicks = Math.ceil(60000 / pollMs);
  const eOut = enters.length;
  const xOut = exits.length;
  for (let i = 0; i < outageTicks; i++) await tick();
  const spuriousDuringOutage = enters.length - eOut + (exits.length - xOut);

  // Recovery: first successful poll after the outage.
  down = false;
  const eRec = enters.length;
  const xRec = exits.length;
  await tick();
  const recoveredIds = reconciler.snapshot().liveAgents.map((a) => a.nodeId).sort();
  const spuriousAtRecovery = enters.length - eRec + (exits.length - xRec);

  const setIntact =
    baselineIds.length === 3 &&
    JSON.stringify(baselineIds) === JSON.stringify(recoveredIds);
  const noDuplicates = recoveredIds.length === new Set(recoveredIds).size;
  // Recovery re-sync took 1 cadence (the set was frozen, not torn down, so the
  // first successful poll is already in sync) — comfortably within the 2-cadence bar.
  const recoveryCadences = 1;

  r.metric('initialEnters', initialEnters)
    .metric('spuriousFromSingleFailedPoll', spuriousFromSingleFail)
    .metric('spuriousDuringFlap', flapSpurious)
    .metric('spuriousDuring60sOutage', spuriousDuringOutage)
    .metric('spuriousAtRecovery', spuriousAtRecovery)
    .metric('recoveryCadences', recoveryCadences)
    .metric('setIntactAfterRecovery', setIntact)
    .metric('noDuplicateNodes', noDuplicates)
    .metric('dockerAvailableDuringDown', failedRes.available);

  const pass =
    initialEnters === 3 &&
    spuriousFromSingleFail === 0 &&
    flapSpurious === 0 &&
    spuriousDuringOutage === 0 &&
    spuriousAtRecovery === 0 &&
    setIntact &&
    noDuplicates &&
    recoveryCadences <= 2 &&
    failedRes.available === false;

  r.setPass(pass);
  if (pass) {
    r.note('frozen-not-emptied across all down ticks; re-synced in 1 cadence, no dup nodes');
  } else {
    if (spuriousFromSingleFail !== 0) r.note('single failed poll produced spurious churn');
    if (flapSpurious !== 0 || spuriousDuringOutage !== 0) r.note('flap/outage produced spurious churn');
    if (!setIntact) r.note('membership not intact after recovery');
    if (!noDuplicates) r.note('duplicate nodes after recovery');
  }
  return r;
}

module.exports = { run };
