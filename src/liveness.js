const { EVENTS } = require('./eventBus');
const { buildLiveEdges, HUB_ID } = require('./model/edges');

const STEP_RE = /^\[(STEP|DONE)\b/;

function defaultTimer() {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    now: () => Date.now(),
  };
}

// Reconciler: fuses Docker poll snapshots (authoritative membership, a level
// signal) with parsed log events (within-container enrichment + fast-path exit)
// into a live agent set, emitting agent:enter / agent:update / agent:exit and a
// recomputed edge set on membership change. See docs/live-monitor-redesign.md
// §2 and §3.2. The `timer` is injectable so tests can drive linger via a fake
// clock.
function createReconciler({
  bus,
  lingerMs = 2500,
  erroredLingerMs = 4000,
  freshnessMs = 15000,
  timer,
} = {}) {
  if (!bus || typeof bus.emit !== 'function') {
    throw new Error('createReconciler requires a bus with emit()');
  }
  const clock = timer || defaultTimer();

  // nodeId -> entry
  const liveAgents = new Map();
  let dockerAvailable = false;
  let edges = [];

  function publicEntry(e) {
    return {
      nodeId: e.nodeId,
      agent: e.agent,
      containerName: e.containerName,
      createdAt: e.createdAt,
      state: e.state,
      step: e.step,
      exitCode: e.exitCode,
    };
  }

  function liveSetArray() {
    return Array.from(liveAgents.values()).map(publicEntry);
  }

  function recomputeEdges() {
    // Edge construction lives in one place (src/model/edges.js).
    edges = buildLiveEdges(liveAgents);
    bus.emit(EVENTS.EDGE_UPDATE, {
      hub: liveAgents.size > 0 ? HUB_ID : null,
      edges: edges.slice(),
      dockerAvailable,
    });
  }

  // Idempotent wind-down: schedule removal once. exitCode === null means the
  // code is unknown (Docker drop with no [exit] line) and is treated as a clean
  // finish for coloring purposes.
  function handleExit(nodeId, exitCode) {
    const entry = liveAgents.get(nodeId);
    if (!entry) return;
    if (entry.exitScheduled) return;
    entry.exitScheduled = true;
    entry.exitCode = exitCode;
    const errored = exitCode !== null && exitCode !== undefined && exitCode !== 0;
    entry.state = errored ? 'exiting:errored' : 'exiting:done';
    bus.emit(EVENTS.AGENT_UPDATE, {
      nodeId,
      state: entry.state,
      step: entry.step != null ? entry.step : null,
      exitCode,
    });
    const linger = errored ? erroredLingerMs : lingerMs;
    entry.exitTimer = clock.setTimeout(() => {
      liveAgents.delete(nodeId);
      bus.emit(EVENTS.AGENT_EXIT, { nodeId, exitCode });
      recomputeEdges();
    }, linger);
  }

  // Authoritative membership. A single available:false poll is treated as
  // 'no change' — never tear down the live set on one failed/empty poll.
  function applyDockerPoll(poll) {
    const { available, containers } = poll || {};
    if (available === false) {
      dockerAvailable = false;
      return;
    }
    dockerAvailable = true;
    const list = Array.isArray(containers) ? containers : [];
    const seen = new Set();
    let membershipChanged = false;

    for (const c of list) {
      if (!c || !c.nodeId) continue;
      const nodeId = c.nodeId;
      seen.add(nodeId);
      if (!liveAgents.has(nodeId)) {
        liveAgents.set(nodeId, {
          nodeId,
          agent: c.agent,
          containerName: c.name,
          createdAt: c.createdAt,
          state: 'dispatching',
          step: null,
          exitScheduled: false,
          exitTimer: null,
          exitCode: null,
        });
        membershipChanged = true;
        bus.emit(EVENTS.AGENT_ENTER, {
          nodeId,
          agent: c.agent,
          containerName: c.name,
          createdAt: c.createdAt,
          state: 'dispatching',
        });
      }
    }

    // Present before but absent now (successful poll) -> begin wind-down.
    for (const [nodeId, entry] of liveAgents) {
      if (!seen.has(nodeId) && !entry.exitScheduled) {
        handleExit(nodeId, null);
      }
    }

    if (membershipChanged) recomputeEdges();
  }

  // Within-container enrichment + fast-path exit, for a KNOWN nodeId only.
  // Accepts a parsed log event shaped like src/parsers/logs.js payloads:
  // { nodeId, state, exitCode, latestStep }.
  function applyLogEvent(parsed) {
    if (!parsed || !parsed.nodeId) return;
    const nodeId = parsed.nodeId;
    const entry = liveAgents.get(nodeId);
    if (!entry) return;

    const code = parsed.exitCode;
    const isExit =
      (code !== null && code !== undefined && Number.isFinite(code)) ||
      parsed.state === 'done' ||
      parsed.state === 'errored';
    if (isExit) {
      const exitCode =
        code !== null && code !== undefined && Number.isFinite(code)
          ? code
          : parsed.state === 'errored'
          ? 1
          : 0;
      handleExit(nodeId, exitCode);
      return;
    }

    const hasStep =
      typeof parsed.latestStep === 'string' && STEP_RE.test(parsed.latestStep);
    if (parsed.state === 'working' || hasStep) {
      entry.state = 'working';
      entry.step = hasStep ? parsed.latestStep : null;
      bus.emit(EVENTS.AGENT_UPDATE, {
        nodeId,
        state: 'working',
        step: entry.step,
      });
    }
  }

  // Degraded log-freshness fallback (used when dockerAvailable === false). Each
  // entry: { nodeId, agent, containerName, createdAt, state, exitCode, hasExec,
  // mtimeMs }. A log with [exec] and no [exit] whose mtime is within freshnessMs
  // is presumed live; stale or absent entries wind down. The CLI supplies mtime.
  function applyLogFreshness(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const now = clock.now();
    const liveIds = new Set();
    let membershipChanged = false;

    for (const e of list) {
      if (!e || !e.nodeId) continue;
      const hasExec = e.state === 'working' || e.hasExec === true;
      const hasExit =
        e.state === 'done' ||
        e.state === 'errored' ||
        (e.exitCode !== null && e.exitCode !== undefined);
      const fresh =
        typeof e.mtimeMs === 'number' ? now - e.mtimeMs <= freshnessMs : true;
      if (!(hasExec && !hasExit && fresh)) continue;

      liveIds.add(e.nodeId);
      if (!liveAgents.has(e.nodeId)) {
        liveAgents.set(e.nodeId, {
          nodeId: e.nodeId,
          agent: e.agent,
          containerName: e.containerName,
          createdAt: e.createdAt,
          state: 'working',
          step: null,
          exitScheduled: false,
          exitTimer: null,
          exitCode: null,
        });
        membershipChanged = true;
        bus.emit(EVENTS.AGENT_ENTER, {
          nodeId: e.nodeId,
          agent: e.agent,
          containerName: e.containerName,
          createdAt: e.createdAt,
          state: 'working',
        });
      }
    }

    for (const [nodeId, entry] of liveAgents) {
      if (!liveIds.has(nodeId) && !entry.exitScheduled) {
        handleExit(nodeId, null);
      }
    }

    if (membershipChanged) recomputeEdges();
  }

  function snapshot() {
    return {
      liveAgents: liveSetArray(),
      edges: edges.slice(),
      dockerAvailable,
    };
  }

  return {
    applyDockerPoll,
    applyLogEvent,
    applyLogFreshness,
    getLiveSet: snapshot,
    snapshot,
  };
}

module.exports = { createReconciler, HUB_ID };
