// Build the LIVE edge set: a synthetic orchestrator hub (`scrum-master`, the
// host session that never appears in `docker ps`) with one inferred, dashed
// dispatch spoke to each currently-live agent. Dispatch parentage is not
// recorded on disk, so every spoke is inferred. Beads dependency edges and
// orchestrator-discovery-from-disk are gone (docs/live-monitor-redesign.md
// §3.2, §3.3, R5).

const HUB_ID = 'scrum-master';

// Accepts a Map (nodeId -> entry), an array of nodeIds/entries, or a plain
// object keyed by nodeId. Returns [] when the live set is empty: spokes hang
// ONLY off live agents. Hub PRESENCE is a separate decision owned by the
// reconciler (journal-active OR >= 1 live agent, §3.2) — a lone hub with no
// spokes is valid, so an empty spoke set does not imply the hub is absent.
function nodeIdsOf(liveAgents) {
  const ids = [];
  if (!liveAgents) return ids;
  if (liveAgents instanceof Map) {
    for (const key of liveAgents.keys()) ids.push(key);
  } else if (Array.isArray(liveAgents)) {
    for (const a of liveAgents) {
      if (typeof a === 'string') ids.push(a);
      else if (a && a.nodeId) ids.push(a.nodeId);
    }
  } else if (typeof liveAgents === 'object') {
    for (const key of Object.keys(liveAgents)) ids.push(key);
  }
  return ids;
}

function buildLiveEdges(liveAgents) {
  const ids = nodeIdsOf(liveAgents);
  if (ids.length === 0) return [];
  return ids.map((nodeId) => ({
    id: `${HUB_ID}->${nodeId}`,
    source: HUB_ID,
    target: nodeId,
    kind: 'dispatch',
    inferred: true,
  }));
}

module.exports = { buildLiveEdges, HUB_ID };
