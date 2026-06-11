// Derive a node's LIVE visual state from log signals. The work-tracking model
// (queued/blocked/static-done) is gone (docs/live-monitor-redesign.md R2/§2.4);
// only states that describe a live or just-finished container remain:
//
//   dispatching      container up, no [exec] yet (transient)
//   working          [exec] seen / actively stepping (the dominant state)
//   exiting:done     finished cleanly (exit code 0, or a Docker drop)
//   exiting:errored  finished with failure (exit code != 0)
//
// This mirrors how src/liveness.js sets state inline, kept here as a single
// reusable helper.

const STATES = Object.freeze({
  DISPATCHING: 'dispatching',
  WORKING: 'working',
  EXITING_DONE: 'exiting:done',
  EXITING_ERRORED: 'exiting:errored',
});

const STEP_RE = /^\[(STEP|DONE)\b/;

// input: { logState, exitCode, hasExec, latestStep }
//   logState   one of 'dispatching'|'working'|'done'|'errored'|null (from logs parser)
//   exitCode   number | null  (an [exit] code, authoritative for exit coloring)
//   hasExec    boolean        (an [exec] line was seen)
//   latestStep string | null  (a [STEP]/[DONE] label implies work is happening)
function deriveState(input) {
  const { logState, exitCode, hasExec, latestStep } = input || {};

  // Exit signals win — a concrete code colors the wind-down.
  if (exitCode !== null && exitCode !== undefined && Number.isFinite(exitCode)) {
    return exitCode === 0 ? STATES.EXITING_DONE : STATES.EXITING_ERRORED;
  }
  if (logState === 'errored') return STATES.EXITING_ERRORED;
  if (logState === 'done') return STATES.EXITING_DONE;

  const stepping = typeof latestStep === 'string' && STEP_RE.test(latestStep);
  if (logState === 'working' || hasExec === true || stepping) {
    return STATES.WORKING;
  }
  return STATES.DISPATCHING;
}

module.exports = { deriveState, STATES };
