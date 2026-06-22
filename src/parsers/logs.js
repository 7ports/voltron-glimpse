const fs = require('node:fs');
const path = require('node:path');

const RE_ENTRY = /^\[entry\]\s+(\S+)/;
const RE_EXEC = /^\[exec\]\s+(\S+)/;
const RE_EXIT = /^\[exit\]\s+(\S+)\s+code=(-?\d+)/;
const RE_STEP = /^\[STEP(?:\s+(\d+))?\]\s*(.*)$/;
const RE_DONE = /^\[DONE\]\s*(.*)$/;

// Embedded-marker variants for stream-JSON logs: the real container wrapper
// writes each line as a JSON event and the agent's [STEP N]/[DONE] markers live
// INSIDE assistant-message `text` fields — not at line-start, and often wrapped
// in backticks. Agents wrap markers three ways, all of which must yield the same
// clean description:
//   1. bare:               [STEP 1] desc
//   2. whole-marker wrap:  `[STEP 1] desc`
//   3. token-only wrap:    `[STEP 2]` desc   <- prose lives AFTER the closing tick
// The optional `` `? `` after `]` swallows the token-only wrapper's closing tick
// so the description capture starts at the prose, not the backtick (which would
// otherwise capture empty). The body then runs to the next backtick / newline /
// end-of-text. Captured text is trimmed by pushStep/pushDone.
const RE_STEP_EMBED = /\[STEP(?:\s+(\d+))?\]`?\s*([^\n`]*)/g;
const RE_DONE_EMBED = /\[DONE\]`?\s*([^\n`]*)/g;

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

// Pull every assistant-message `text` blob out of a single stream-JSON line.
// Tolerates malformed/partial JSON (returns []) and any unexpected shape.
function collectTextBlobs(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  const content = obj && obj.message && obj.message.content;
  if (!Array.isArray(content)) return [];
  const blobs = [];
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') {
      blobs.push(part.text);
    }
  }
  return blobs;
}

// True iff a tool_use `name` denotes a sub-agent dispatch. The verified primary
// path is the Agent-SDK `Agent` tool; `Task` is its alias; the MCP variant's
// name ends with `run_agent_in_docker` (e.g. mcp__project-voltron__run_agent_in_docker).
function isDispatchToolName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  return name === 'Agent' || name === 'Task' || /run_agent_in_docker/.test(name);
}

// Normalize a child-agent slug: trim + lower-case so it joins cleanly to the
// tier map / frontend. Returns '' for any non-string / empty input.
function normalizeChildAgent(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

// Derive a short task label for a dispatch start from its tool_use `input`:
// prefer `description`, then `task`, then the first ~80 chars of `prompt`.
function deriveDispatchTask(input) {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.description === 'string' && input.description.trim()) {
    return input.description.trim();
  }
  if (typeof input.task === 'string' && input.task.trim()) {
    return input.task.trim();
  }
  if (typeof input.prompt === 'string' && input.prompt.trim()) {
    return input.prompt.trim().slice(0, 80);
  }
  return null;
}

// Walk a single stream-JSON line's `message.content[]` for STRUCTURED dispatch
// signals ONLY — never prose. Emits, in document order:
//   { kind: 'dispatch:start', toolUseId, childAgent, description }
//     ← an assistant `tool_use` block whose name is Agent/Task/…run_agent_in_docker
//       AND that carries a child-agent id (input.subagent_type | input.agent_name |
//       input.agent_type) AND a tool_use id.
//   { kind: 'dispatch:end', toolUseId }
//     ← a `tool_result` block with a non-empty tool_use_id.
// This is the false-positive firewall (design §2.1): `text` blocks, the word
// "dispatch" in prose, and non-dispatch tools (Bash/Read/Edit/…) yield NOTHING.
// Tolerates malformed/partial JSON (returns []) and never throws.
function collectDispatchMarkers(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  const content = obj && obj.message && obj.message.content;
  if (!Array.isArray(content)) return [];
  const markers = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'tool_use') {
      if (!isDispatchToolName(part.name)) continue;
      if (typeof part.id !== 'string' || part.id.length === 0) continue;
      const input = part.input || {};
      const childAgent = normalizeChildAgent(
        input.subagent_type || input.agent_name || input.agent_type
      );
      if (!childAgent) continue;
      markers.push({
        kind: 'dispatch:start',
        toolUseId: part.id,
        childAgent,
        description: deriveDispatchTask(input),
      });
    } else if (part.type === 'tool_result') {
      if (typeof part.tool_use_id !== 'string' || part.tool_use_id.length === 0) continue;
      markers.push({ kind: 'dispatch:end', toolUseId: part.tool_use_id });
    }
  }
  return markers;
}

// Scan a stream-JSON line's assistant text for embedded [STEP N]/[DONE] markers
// and replay them, in document order, through the same recorders the
// line-anchored path uses. Never throws.
function extractJsonMarkers(line, pushStep, pushDone) {
  for (const text of collectTextBlobs(line)) {
    const hits = [];
    let m;
    RE_STEP_EMBED.lastIndex = 0;
    while ((m = RE_STEP_EMBED.exec(text))) {
      hits.push({ index: m.index, kind: 'step', num: m[1], body: m[2] });
    }
    RE_DONE_EMBED.lastIndex = 0;
    while ((m = RE_DONE_EMBED.exec(text))) {
      hits.push({ index: m.index, kind: 'done', body: m[1] });
    }
    hits.sort((a, b) => a.index - b.index);
    for (const h of hits) {
      if (h.kind === 'step') pushStep(h.num, h.body);
      else pushDone(h.body);
    }
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
  // Additive, purely structural: dispatch:start/dispatch:end markers mined from
  // stream-JSON tool_use/tool_result blocks (NEVER from prose). The reconciler
  // pairs start↔end across tail chunks; the parser only reports raw markers in
  // document order. See collectDispatchMarkers + design §2.1.
  const dispatches = [];

  // Shared step/done recorders so the line-anchored path and the stream-JSON
  // path produce identical { stepNum, text } shapes and latestStep updates.
  function pushStep(numStr, body) {
    const text = (body || '').trim();
    let label;
    if (numStr) {
      stepNum = parseInt(numStr, 10);
      label = text ? `[STEP ${numStr}] ${text}` : `[STEP ${numStr}]`;
    } else {
      stepNum = null;
      label = text ? `[STEP] ${text}` : '[STEP]';
    }
    latestStep = label;
    steps.push({ stepNum: numStr ? parseInt(numStr, 10) : null, text: label });
  }
  function pushDone(body) {
    const summary = (body || '').trim();
    const label = summary ? `[DONE] ${summary}` : '[DONE]';
    latestStep = label;
    steps.push({ stepNum: null, text: label });
  }

  for (const line of lines) {
    if (!line) continue;
    const c0 = line.charCodeAt(0);

    // Stream-JSON line: parse it and mine assistant-message text for embedded
    // [STEP N]/[DONE] markers. Malformed/partial JSON is skipped, never thrown.
    if (c0 === 123 /* '{' */) {
      extractJsonMarkers(line, pushStep, pushDone);
      for (const marker of collectDispatchMarkers(line)) {
        dispatches.push(marker);
      }
      continue;
    }

    if (c0 !== 91 /* '[' */) continue;

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
      pushStep(m[1], m[2]);
    } else if ((m = RE_DONE.exec(line))) {
      pushDone(m[1]);
    }
  }

  if (latestStep === null) {
    latestStep = defaultLabel(state, exitCode);
  }

  return { nodeId, agent, state, exitCode, latestStep, stepNum, execTs, steps, containerName, dispatches };
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
  let start = Math.max(0, Number(fromOffset) || 0);
  // Truncation-in-place recovery: a tracked offset GREATER than the file's
  // current size means the file shrank (was truncated, then possibly
  // re-appended). The stale offset would skip every post-truncation byte, so
  // reset to 0 and read the file from the beginning. (start === size is the
  // normal "no new bytes" case and is left to the early-return below.)
  if (start > size) {
    start = 0;
  }
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
