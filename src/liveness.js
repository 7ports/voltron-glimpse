const { EVENTS } = require('./eventBus');
const { buildLiveEdges, HUB_ID } = require('./model/edges');

const STEP_RE = /^\[(STEP|DONE)\b/;

// Recent-activity ring buffer size per live agent (newest-first). §3.3.
const RECENT_STEPS_MAX = 5;

// Best-effort: turn a journal dispatch line ("Dispatched `agent` (B1) to <task>")
// into just the task prose. Falls back to the full trimmed text when there is no
// recognizable " to " tail — honest, never wrong.
function stripDispatchPrefix(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  const m = /^dispatch(?:ed|ing)?\b.*?\bto\s+(.+)$/i.exec(t);
  if (m && m[1] && m[1].trim()) return m[1].trim();
  return t;
}

// §3.5 dispatch correlation: scan a `dispatch` journal line's free text for the
// DISPATCHED agent slug (the actor is always scrum-master; the target is named
// in the prose, e.g. "Dispatched `fullstack-dev` (B1) to …"). Best-effort: a
// missed parse simply means no flash, never a wrong edge.
const DISPATCH_RE = /dispatch(?:ed|ing)?\s+`?([A-Za-z][\w-]*)/i;

function normalizeAgent(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

// Pull the dispatched agent slug out of a JournalSignal. Prefers an explicit
// `dispatchTarget` (set by the parser when confident), else heuristically scans
// the text. Returns a lowercased slug or null when nothing is recognizable.
function extractDispatchTarget(signal) {
  if (!signal) return null;
  if (typeof signal.dispatchTarget === 'string' && signal.dispatchTarget.trim()) {
    return signal.dispatchTarget.trim().toLowerCase();
  }
  if (typeof signal.text === 'string') {
    const m = DISPATCH_RE.exec(signal.text);
    if (m && m[1]) return m[1].toLowerCase();
  }
  return null;
}

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
  hubFreshnessMs = 60000,
  dispatchWindowMs = 10000,
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

  // --- Orchestrator hub liveness (journal-inferred) ----------------------
  // The synthetic scrum-master hub is NOT a container; its only states are
  // 'active' (journaled within hubFreshnessMs) and 'idle' (gone quiet). It is
  // PRESENT iff journal-active OR >= 1 live agent (§3.2); when idle AND empty it
  // is removed. Label/kind/emoji/time come from the latest journal entry.
  let hubState = 'idle';
  let hubLabel = null;
  let hubKind = null;
  let hubEmoji = null;
  let hubTime = null;
  let lastJournalTs = null;
  let hubIdleTimer = null;
  let lastHubPresent = false;

  // --- Dispatch correlation (§3.5, best-effort) --------------------------
  // A short list of recently-journaled dispatches { agent, ts }. When a matching
  // container ENTERS within dispatchWindowMs we flash its hub→agent spoke once.
  // Pending entries expire silently; this never gates the normal enter flow.
  let pendingDispatches = [];

  function prunePending(now) {
    if (pendingDispatches.length === 0) return;
    pendingDispatches = pendingDispatches.filter((pd) => now - pd.ts <= dispatchWindowMs);
  }

  function containerMatches(pdAgent, container) {
    // The journal is the SELF pod's; a dispatch must only correlate to a
    // self-pod container. Without this guard a same-named agent in a FOREIGN
    // pod could steal the flash + task prose (a cross-pod honesty bug).
    if (container.selfPod !== true) return false;
    return (
      pdAgent === normalizeAgent(container.agent) ||
      pdAgent === normalizeAgent(container.nodeId)
    );
  }

  function isHubPresent() {
    return hubState === 'active' || liveAgents.size > 0;
  }

  function hubSnapshot() {
    if (!isHubPresent()) return null;
    return {
      id: HUB_ID,
      state: hubState,
      label: hubLabel,
      kind: hubKind,
      emoji: hubEmoji,
      time: hubTime,
    };
  }

  function publicEntry(e) {
    return {
      nodeId: e.nodeId,
      agent: e.agent,
      containerName: e.containerName,
      createdAt: e.createdAt,
      podKey: e.podKey != null ? e.podKey : null,
      podLabel: e.podLabel != null ? e.podLabel : null,
      selfPod: e.selfPod === true,
      // observed: are this container's logs actually being tailed? false means its
      // pod's host log dir could not be resolved/read (foreign pod, path-translation
      // failure, permission denied, missing dir) — so [exec]/[STEP]/[exit] will
      // never arrive and the UI must say "logs unobserved" rather than imply a
      // perpetually-stuck dispatch. Defaults true unless explicitly flagged false.
      observed: e.observed !== false,
      state: e.state,
      step: e.step,
      exitCode: e.exitCode,
      execTs: e.execTs != null ? e.execTs : null,
      stepNum: e.stepNum != null ? e.stepNum : null,
      stepCount: e.stepCount || 0,
      recentSteps: Array.isArray(e.recentSteps) ? e.recentSteps.slice() : [],
      dispatchTaskText: e.dispatchTaskText != null ? e.dispatchTaskText : null,
      doneSummary: e.doneSummary != null ? e.doneSummary : null,
    };
  }

  function liveSetArray() {
    return Array.from(liveAgents.values()).map(publicEntry);
  }

  function recomputeEdges() {
    // Edge construction lives in one place (src/model/edges.js). Spokes only
    // hang off LIVE agents, so the edge array is empty with zero agents — but
    // the hub itself can still be PRESENT (journal-active, §3.2): a lone hub
    // with no spokes is valid.
    edges = buildLiveEdges(liveAgents);
    const present = isHubPresent();
    bus.emit(EVENTS.EDGE_UPDATE, {
      hub: present ? HUB_ID : null,
      edges: edges.slice(),
      dockerAvailable,
    });
    // The hub can vanish purely from an agent exit (last agent gone while the
    // journal is already idle); null it on consumers when presence drops.
    if (lastHubPresent && !present) {
      bus.emit(EVENTS.HUB_UPDATE, { id: HUB_ID, present: false });
    }
    lastHubPresent = present;
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
      stepNum: entry.stepNum != null ? entry.stepNum : null,
      stepCount: entry.stepCount || 0,
      execTs: entry.execTs != null ? entry.execTs : null,
      recentSteps: Array.isArray(entry.recentSteps) ? entry.recentSteps.slice() : [],
      dispatchTaskText: entry.dispatchTaskText != null ? entry.dispatchTaskText : null,
      doneSummary: entry.doneSummary != null ? entry.doneSummary : null,
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
    prunePending(clock.now());

    for (const c of list) {
      if (!c || !c.nodeId) continue;
      const nodeId = c.nodeId;
      seen.add(nodeId);
      if (!liveAgents.has(nodeId)) {
        const entry = {
          nodeId,
          agent: c.agent,
          containerName: c.name,
          createdAt: c.createdAt,
          podKey: c.podKey != null ? c.podKey : null,
          podLabel: c.podLabel != null ? c.podLabel : null,
          selfPod: c.selfPod === true,
          observed: c.observed !== false,
          state: 'dispatching',
          step: null,
          exitScheduled: false,
          exitTimer: null,
          exitCode: null,
          execTs: null,
          stepNum: null,
          stepCount: 0,
          recentSteps: [],
          dispatchTaskText: null,
          doneSummary: null,
        };
        liveAgents.set(nodeId, entry);
        membershipChanged = true;
        const enterPayload = {
          nodeId,
          agent: c.agent,
          containerName: c.name,
          createdAt: c.createdAt,
          podKey: c.podKey != null ? c.podKey : null,
          podLabel: c.podLabel != null ? c.podLabel : null,
          selfPod: c.selfPod === true,
          observed: c.observed !== false,
          state: 'dispatching',
        };
        // §3.5: correlate a recent dispatch to this fresh container; flash once
        // and consume the pending entry so it can never flash twice. Best-effort:
        // also carry the dispatch line's task prose onto the entry + enter payload.
        const matchIdx = pendingDispatches.findIndex((pd) => containerMatches(pd.agent, c));
        if (matchIdx !== -1) {
          const pd = pendingDispatches[matchIdx];
          pendingDispatches.splice(matchIdx, 1);
          enterPayload.dispatchFlash = true;
          if (pd && typeof pd.text === 'string' && pd.text.trim()) {
            const taskText = stripDispatchPrefix(pd.text);
            entry.dispatchTaskText = taskText;
            enterPayload.dispatchTaskText = taskText;
          }
        }
        bus.emit(EVENTS.AGENT_ENTER, enterPayload);
      } else {
        // Existing container: observability can flip once a previously-unresolved
        // pod mount-source resolves (or its log dir appears). Keep it honest.
        const entry = liveAgents.get(nodeId);
        const nextObserved = c.observed !== false;
        if (entry && !entry.exitScheduled && entry.observed !== nextObserved) {
          entry.observed = nextObserved;
          bus.emit(EVENTS.AGENT_UPDATE, { nodeId, observed: nextObserved });
        }
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

      // execTs is set ONCE (first [exec] seen) and never overwritten.
      if (entry.execTs == null && parsed.execTs != null) {
        entry.execTs = parsed.execTs;
      }

      // Prefer the full per-chunk steps[] (lossless); fall back to the single
      // latestStep when an older single-event payload arrives without steps[].
      let chunkSteps = Array.isArray(parsed.steps) ? parsed.steps : null;
      if (!chunkSteps || chunkSteps.length === 0) {
        chunkSteps = hasStep
          ? [{ stepNum: parsed.stepNum != null ? parsed.stepNum : null, text: parsed.latestStep }]
          : [];
      }

      if (chunkSteps.length > 0) {
        if (!Array.isArray(entry.recentSteps)) entry.recentSteps = [];
        for (const s of chunkSteps) {
          entry.stepCount = (entry.stepCount || 0) + 1;
          if (s && s.stepNum != null) entry.stepNum = s.stepNum;
          entry.recentSteps.unshift({
            stepNum: s && s.stepNum != null ? s.stepNum : null,
            text: s ? s.text : null,
          });
          if (entry.recentSteps.length > RECENT_STEPS_MAX) {
            entry.recentSteps.length = RECENT_STEPS_MAX;
          }
        }
      } else if (parsed.stepNum != null) {
        entry.stepNum = parsed.stepNum;
      }

      // Surface a [DONE] summary as its own field for the panel fallback chain.
      if (hasStep && parsed.latestStep.indexOf('[DONE]') === 0) {
        const summary = parsed.latestStep.slice('[DONE]'.length).trim();
        entry.doneSummary = summary || null;
      }

      bus.emit(EVENTS.AGENT_UPDATE, {
        nodeId,
        state: 'working',
        step: entry.step,
        stepNum: entry.stepNum != null ? entry.stepNum : null,
        stepCount: entry.stepCount || 0,
        execTs: entry.execTs != null ? entry.execTs : null,
        recentSteps: entry.recentSteps.slice(),
        doneSummary: entry.doneSummary != null ? entry.doneSummary : null,
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

  function flipHubIdle() {
    hubIdleTimer = null;
    if (hubState !== 'active') return;
    hubState = 'idle';
    if (liveAgents.size > 0) {
      // Agents still live: dim the hub in place, keep it present.
      bus.emit(EVENTS.HUB_UPDATE, {
        id: HUB_ID,
        present: true,
        state: 'idle',
        label: hubLabel,
        kind: hubKind,
        emoji: hubEmoji,
        time: hubTime,
      });
      lastHubPresent = true;
    } else {
      // Idle AND empty: remove the hub (present-tense / ephemeral rule).
      bus.emit(EVENTS.HUB_UPDATE, { id: HUB_ID, present: false });
      lastHubPresent = false;
      recomputeEdges();
    }
  }

  // Journal-inferred hub liveness. Each parsed JournalSignal marks the
  // orchestrator active, refreshes the "doing now" label, and (re)arms the
  // idle-tick that flips active -> idle once hubFreshnessMs lapses with no new
  // append. Read-only: the signal comes from tailing the journal, never writing.
  function applyJournalEvent(signal) {
    if (!signal) return;
    const wasPresent = isHubPresent();
    lastJournalTs = clock.now();
    // §3.5: a dispatch line primes a pending correlation; a matching container
    // entering within dispatchWindowMs will flash its spoke.
    if (signal.kind === 'dispatch') {
      prunePending(lastJournalTs);
      const target = extractDispatchTarget(signal);
      if (target)
        pendingDispatches.push({
          agent: target,
          ts: lastJournalTs,
          text: typeof signal.text === 'string' ? signal.text : null,
        });
    }
    hubState = 'active';
    if (signal.text != null) hubLabel = signal.text;
    if (signal.kind != null) hubKind = signal.kind;
    if (signal.emoji != null) hubEmoji = signal.emoji;
    if (signal.time != null) hubTime = signal.time;
    bus.emit(EVENTS.HUB_UPDATE, {
      id: HUB_ID,
      present: true,
      state: 'active',
      label: hubLabel,
      kind: hubKind,
      emoji: hubEmoji,
      time: hubTime,
    });
    if (hubIdleTimer) clock.clearTimeout(hubIdleTimer);
    hubIdleTimer = clock.setTimeout(flipHubIdle, hubFreshnessMs);
    // If the hub was absent (idle + empty) it has just appeared with zero
    // agents: refresh edges so the EDGE_UPDATE hub field flips to HUB_ID.
    if (!wasPresent) recomputeEdges();
    else lastHubPresent = true;
  }

  function snapshot() {
    return {
      liveAgents: liveSetArray(),
      edges: edges.slice(),
      dockerAvailable,
      hub: hubSnapshot(),
    };
  }

  return {
    applyDockerPoll,
    applyLogEvent,
    applyLogFreshness,
    applyJournalEvent,
    getLiveSet: snapshot,
    snapshot,
  };
}

module.exports = { createReconciler, HUB_ID };
