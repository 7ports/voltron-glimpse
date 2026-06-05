const { execFileSync } = require('child_process');
const { EVENTS } = require('../eventBus');

function parseBeadList(jsonStringOrArray) {
  let arr;
  if (Array.isArray(jsonStringOrArray)) {
    arr = jsonStringOrArray;
  } else if (typeof jsonStringOrArray === 'string') {
    try {
      arr = JSON.parse(jsonStringOrArray);
    } catch (_err) {
      return [];
    }
  } else {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out = [];
  for (const bead of arr) {
    if (!bead || typeof bead !== 'object' || typeof bead.id !== 'string') continue;

    out.push({
      event: EVENTS.AGENT_UPDATE,
      payload: {
        kind: 'bead',
        id: bead.id,
        title: bead.title || '',
        status: bead.status || 'open',
        priority: typeof bead.priority === 'number' ? bead.priority : null,
        issue_type: bead.issue_type || 'task',
        assignee: bead.assignee || bead.owner || null,
        updated_at: bead.updated_at || null,
      },
    });

    const deps = Array.isArray(bead.dependencies) ? bead.dependencies : [];
    for (const dep of deps) {
      if (!dep || typeof dep !== 'object') continue;
      const from = dep.depends_on_id;
      const to = dep.issue_id;
      if (typeof from !== 'string' || typeof to !== 'string') continue;
      out.push({
        event: EVENTS.EDGE_UPDATE,
        payload: {
          from,
          to,
          kind: 'dependency',
          declared: true,
        },
      });
    }
  }
  return out;
}

function defaultExec(cwd) {
  return execFileSync('bd', ['list', '--json'], { cwd, encoding: 'utf8' });
}

function loadBeads(projectRoot, execImpl) {
  const runner = typeof execImpl === 'function' ? execImpl : defaultExec;
  let raw;
  try {
    raw = runner(projectRoot);
  } catch (_err) {
    return [];
  }
  if (raw == null) return [];
  try {
    return parseBeadList(raw);
  } catch (_err) {
    return [];
  }
}

module.exports = { parseBeadList, loadBeads };
