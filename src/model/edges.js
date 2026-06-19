// Build the LIVE edge set. Two honesty tiers (docs/tier2-tier3-dispatch-
// visibility.md §5, docs/live-monitor-redesign.md §3.2, §3.3):
//
//   • Real, container-backed agent → an inferred, dashed `dispatch` spoke from
//     the single synthetic orchestrator hub (`scrum-master`, the host session
//     that never appears in `docker ps`). Dispatch parentage is not recorded on
//     disk, so every spoke is inferred.
//   • Inferred Tier-3 child (synthesized from a parent's stream-JSON dispatch,
//     id `sub::<toolUseId>`, carrying `parentNodeId`) → a `subdispatch` edge from
//     its LIVE parent to the child, NOT a hub spoke. This is doubly inferred (the
//     relationship AND the child's very existence), so it gets a distinct kind so
//     the frontend can style it apart (dashed violet).
//   • An inferred child whose parent is not in the live set is an orphan and
//     draws NO edge — attaching it to the hub would assert a dispatch we cannot
//     honestly claim (§3.3).
//
// Beads dependency edges and orchestrator-discovery-from-disk are gone.

const HUB_ID = 'scrum-master';

// Normalize the live set into entry OBJECTS so edge construction can read
// `inferred`/`parentNodeId`, not just nodeIds. Accepts a Map (nodeId -> entry),
// an array of nodeIds/entries, or a plain object keyed by nodeId. A pure-string
// input yields entries with only `nodeId` set (no `inferred`/`parentNodeId`), so
// such inputs are always treated as real agents — preserving the original
// hub-spoke behavior for back-compat.
function entriesOf(liveAgents) {
  const entries = [];
  if (!liveAgents) return entries;
  if (liveAgents instanceof Map) {
    for (const [key, value] of liveAgents.entries()) {
      if (value && typeof value === 'object') {
        entries.push(value.nodeId ? value : { ...value, nodeId: key });
      } else {
        entries.push({ nodeId: key });
      }
    }
  } else if (Array.isArray(liveAgents)) {
    for (const a of liveAgents) {
      if (typeof a === 'string') entries.push({ nodeId: a });
      else if (a && a.nodeId) entries.push(a);
    }
  } else if (typeof liveAgents === 'object') {
    for (const key of Object.keys(liveAgents)) {
      const value = liveAgents[key];
      if (value && typeof value === 'object') {
        entries.push(value.nodeId ? value : { ...value, nodeId: key });
      } else {
        entries.push({ nodeId: key });
      }
    }
  }
  return entries;
}

function buildLiveEdges(liveAgents) {
  const entries = entriesOf(liveAgents);
  if (entries.length === 0) return [];
  const ids = new Set(entries.map((e) => e.nodeId));
  const edges = [];
  for (const e of entries) {
    if (e.inferred && e.parentNodeId) {
      // Tier-2 → Tier-3: child hangs off its REAL, live parent — never the hub.
      // Orphan (parent absent) draws no edge (honesty, §3.3).
      if (ids.has(e.parentNodeId)) {
        edges.push({
          id: `${e.parentNodeId}->${e.nodeId}`,
          source: e.parentNodeId,
          target: e.nodeId,
          kind: 'subdispatch',
          inferred: true,
        });
      }
    } else if (!e.inferred) {
      // Unchanged: hub → real container.
      edges.push({
        id: `${HUB_ID}->${e.nodeId}`,
        source: HUB_ID,
        target: e.nodeId,
        kind: 'dispatch',
        inferred: true,
      });
    }
    // An inferred child with no parentNodeId at all also draws nothing.
  }
  return edges;
}

module.exports = { buildLiveEdges, HUB_ID };
