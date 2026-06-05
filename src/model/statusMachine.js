// Derive a node's visual state by combining progress.json status with log
// signals. Precedence (highest first):
//   errored > blocked > done > working > dispatching > queued
// When both a log signal and a progress signal are present, the log wins
// unless progress carries a higher-precedence state (errored / blocked).

const STATES = Object.freeze({
  QUEUED: 'queued',
  DISPATCHING: 'dispatching',
  WORKING: 'working',
  DONE: 'done',
  BLOCKED: 'blocked',
  ERRORED: 'errored',
});

const PROGRESS_TO_STATE = Object.freeze({
  queued: 'queued',
  in_progress: 'working',
  completed: 'done',
  blocked: 'blocked',
  failed: 'errored',
});

function logCandidate(logState, exitCode) {
  if (logState === 'errored') return 'errored';
  if (logState === 'done') return 'done';
  if (logState === 'working') return 'working';
  if (logState === 'dispatching') return 'dispatching';
  if (typeof exitCode === 'number') {
    if (exitCode !== 0) return 'errored';
    return 'done';
  }
  return null;
}

function progressCandidate(progressStatus) {
  if (typeof progressStatus !== 'string') return null;
  return PROGRESS_TO_STATE[progressStatus] || null;
}

function deriveState(input) {
  const { progressStatus, logState, exitCode } = input || {};
  const fromLog = logCandidate(logState, exitCode);
  const fromProgress = progressCandidate(progressStatus);

  // Highest-precedence states win regardless of source.
  if (fromLog === 'errored' || fromProgress === 'errored') return 'errored';
  if (fromProgress === 'blocked') return 'blocked';

  // Below errored/blocked: log signal wins when present (progress may be stale).
  if (fromLog) return fromLog;
  if (fromProgress) return fromProgress;
  return 'queued';
}

module.exports = { deriveState, STATES };
