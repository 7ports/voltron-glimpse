// Build the edge set for the graph from the current node set + declared
// bead dependencies. Two visually distinct edge kinds:
//   - 'dispatch'   inferred (dashed) — orchestrator-as-root star
//   - 'dependency' declared (solid) — from `bd list --json` dependencies
// Dispatch edges are inferred because dispatcher/parent relationships are
// not recorded on disk by Voltron; only declared bead deps are authoritative.

const BATCH_WINDOW_MS = 3000;
const ORCHESTRATOR_AGENTS = new Set(['scrum-master', 'code-analyst']);

function toMs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string' && ts.length > 0) {
    const v = Date.parse(ts);
    return Number.isNaN(v) ? null : v;
  }
  return null;
}

function pickOrchestrator(nodes) {
  for (const n of nodes) {
    if (n && ORCHESTRATOR_AGENTS.has(n.agent)) return n;
  }
  let earliest = null;
  let earliestMs = Infinity;
  for (const n of nodes) {
    if (!n) continue;
    const ms = toMs(n.startedAt);
    if (ms !== null && ms < earliestMs) {
      earliest = n;
      earliestMs = ms;
    }
  }
  return earliest;
}

function assignBatchGroups(nodes) {
  const dated = nodes
    .map((n) => ({ node: n, ms: toMs(n && n.startedAt) }))
    .filter((x) => x.ms !== null)
    .sort((a, b) => a.ms - b.ms);

  const batchById = new Map();
  let batchStartMs = -Infinity;
  let batchLabel = null;
  let batchCounter = 0;

  for (const { node, ms } of dated) {
    if (batchLabel === null || ms - batchStartMs > BATCH_WINDOW_MS) {
      batchCounter += 1;
      batchLabel = `batch-${batchCounter}`;
      batchStartMs = ms;
    }
    batchById.set(node.id, batchLabel);
  }
  return batchById;
}

function buildEdges(nodes, beadDeps) {
  const safeNodes = Array.isArray(nodes)
    ? nodes.filter((n) => n && typeof n.id === 'string')
    : [];
  const safeDeps = Array.isArray(beadDeps) ? beadDeps : [];
  const edges = [];

  if (safeNodes.length > 0) {
    const orchestrator = pickOrchestrator(safeNodes);
    if (orchestrator) {
      const batchById = assignBatchGroups(safeNodes);
      for (const n of safeNodes) {
        if (n.id === orchestrator.id) continue;
        edges.push({
          from: orchestrator.id,
          to: n.id,
          kind: 'dispatch',
          inferred: true,
          batchGroup: batchById.get(n.id) || null,
        });
      }
    }
  }

  for (const dep of safeDeps) {
    if (!dep || typeof dep !== 'object') continue;
    const { from, to } = dep;
    if (typeof from !== 'string' || typeof to !== 'string') continue;
    edges.push({ from, to, kind: 'dependency', declared: true });
  }

  return edges;
}

module.exports = { buildEdges };
