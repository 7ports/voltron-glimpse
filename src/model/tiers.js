// Baked-in snapshot of Voltron's agent->tier map (sourced from
// project-voltron/src/templates.js tier tables). Tiers are NOT recorded on
// disk anywhere, so this is a static snapshot — refresh when Voltron adds
// new agents. Unknown agents default to Tier 3 so the graph still renders.

const TIER_MAP = Object.freeze({
  // Tier 1 — orchestrators / planners (largest)
  'scrum-master': 1,
  'code-analyst': 1,
  'doc-writer': 1,
  'project-planner': 1,
  'reflection-processor': 1,

  // Tier 2 — sub-managers (medium)
  'fullstack-dev': 2,
  'csharp-dev': 2,
  'devops-engineer': 2,
  'qa-tester': 2,
  'scene-architect': 2,
  'ui-designer': 2,
  'shader-artist': 2,
  'asset-manager': 2,
});

function getTier(agentName) {
  if (typeof agentName !== 'string' || agentName.length === 0) return 3;
  const t = TIER_MAP[agentName];
  return typeof t === 'number' ? t : 3;
}

module.exports = { getTier, TIER_MAP };
