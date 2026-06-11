const fs = require('node:fs');
const path = require('node:path');

const RE_ENTRY = /^\[entry\]\s+(\S+)/;
const RE_EXEC = /^\[exec\]\s+(\S+)/;
const RE_EXIT = /^\[exit\]\s+(\S+)\s+code=(-?\d+)/;
const RE_STEP = /^\[STEP(?:\s+(\d+))?\]\s*(.*)$/;
const RE_DONE = /^\[DONE\]\s*(.*)$/;

const ISO_SUFFIX_RE = /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-[A-Za-z0-9]+)?$/;

function deriveContainerName(filename) {
  if (typeof filename !== 'string' || filename.length === 0) return '';
  return path.basename(filename).replace(/\.log$/i, '');
}

function deriveAgentName(containerName) {
  if (!containerName) return '';
  const stripped = containerName.replace(ISO_SUFFIX_RE, '');
  return stripped || containerName;
}

function defaultLabel(state, exitCode) {
  switch (state) {
    case 'dispatching':
      return 'container started';
    case 'working':
      return 'agent running';
    case 'done':
      return 'completed (exit 0)';
    case 'errored':
      return `errored (exit ${exitCode})`;
    default:
      return null;
  }
}

// Parse a full log file's content into ONE consolidated live-state payload
// for the reconciler (src/liveness.js applyLogEvent). Returns null when the
// filename is unusable. Shape: { nodeId, agent, state, exitCode, latestStep,
// stepNum, execTs, steps, containerName }. `state` is null when no recognizable
// lifecycle line is seen. `execTs` is the `[exec] <ts>` token (null if absent);
// `stepNum` is the integer N of the LATEST `[STEP N]` (null for an unnumbered
// `[STEP]` or no step); `steps` is EVERY step/done line found in this chunk, in
// order, as { stepNum, text } — so a multi-step tail chunk loses none of them.
function parseLog(content, filename) {
  if (typeof content !== 'string' || typeof filename !== 'string') {
    return null;
  }
  const containerName = deriveContainerName(filename);
  if (!containerName) return null;
  const agent = deriveAgentName(containerName);
  const nodeId = containerName;

  const lines = content.split(/\r?\n/);

  let state = null;
  let exitCode = null;
  let latestStep = null;
  let execTs = null;
  let stepNum = null;
  const steps = [];

  for (const line of lines) {
    if (!line || line.charCodeAt(0) !== 91) continue;

    let m;
    if ((m = RE_ENTRY.exec(line))) {
      if (state === null) state = 'dispatching';
    } else if ((m = RE_EXEC.exec(line))) {
      state = 'working';
      if (execTs === null && m[1]) execTs = m[1];
    } else if ((m = RE_EXIT.exec(line))) {
      exitCode = parseInt(m[2], 10);
      state = exitCode === 0 ? 'done' : 'errored';
    } else if ((m = RE_STEP.exec(line))) {
      const num = m[1];
      const text = (m[2] || '').trim();
      let label;
      if (num) {
        stepNum = parseInt(num, 10);
        label = text ? `[STEP ${num}] ${text}` : `[STEP ${num}]`;
      } else {
        stepNum = null;
        label = text ? `[STEP] ${text}` : '[STEP]';
      }
      latestStep = label;
      steps.push({ stepNum: num ? parseInt(num, 10) : null, text: label });
    } else if ((m = RE_DONE.exec(line))) {
      const summary = (m[1] || '').trim();
      const label = summary ? `[DONE] ${summary}` : '[DONE]';
      latestStep = label;
      steps.push({ stepNum: null, text: label });
    }
  }

  if (latestStep === null) {
    latestStep = defaultLabel(state, exitCode);
  }

  return { nodeId, agent, state, exitCode, latestStep, stepNum, execTs, steps, containerName };
}

// Read only the bytes appended since `fromOffset`, parse them, and return the
// resulting payload (or null when nothing new / unreadable) plus the new offset.
function tailLog(filePath, fromOffset = 0) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { event: null, newOffset: Number(fromOffset) || 0 };
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return { event: null, newOffset: Number(fromOffset) || 0 };
  }
  const size = stat.size;
  const start = Math.max(0, Number(fromOffset) || 0);
  if (start >= size) {
    return { event: null, newOffset: size };
  }
  const length = size - start;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  const event = parseLog(buf.toString('utf8'), filePath);
  return { event, newOffset: size };
}

module.exports = { parseLog, tailLog, deriveContainerName, deriveAgentName };
