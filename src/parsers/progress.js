const { EVENTS } = require('../eventBus');

const STATUS_KEYS = ['queued', 'in_progress', 'completed', 'failed', 'blocked'];

function parseProgress(jsonStringOrObject) {
  let data = jsonStringOrObject;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (_e) {
      return [];
    }
  }
  if (data === null || typeof data !== 'object') return [];
  const tasks = data.tasks;
  if (!Array.isArray(tasks)) return [];

  const agentEvents = [];
  const phaseOrder = [];
  const phaseStats = new Map();
  const counts = {};
  for (const key of STATUS_KEYS) counts[key] = 0;

  for (const task of tasks) {
    if (task === null || typeof task !== 'object' || Array.isArray(task)) continue;

    agentEvents.push({
      event: EVENTS.AGENT_UPDATE,
      payload: {
        taskId: task.task_id ?? null,
        agent: task.agent ?? null,
        status: task.status ?? null,
        phase: task.phase ?? null,
        description: task.description ?? null,
        createdAt: task.created_at ?? null,
        startedAt: task.started_at ?? null,
        completedAt: task.completed_at ?? null,
        updatedAt: task.updated_at ?? null,
      },
    });

    const phase = task.phase;
    if (typeof phase === 'string' && phase.length > 0) {
      if (!phaseStats.has(phase)) {
        phaseOrder.push(phase);
        phaseStats.set(phase, { total: 0, done: 0 });
      }
      const stat = phaseStats.get(phase);
      stat.total += 1;
      if (task.status === 'completed') stat.done += 1;
    }

    const status = task.status;
    if (typeof status === 'string' && status.length > 0 && Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] += 1;
    }
  }

  const phaseEvents = phaseOrder.map((phase) => ({
    event: EVENTS.PHASE_UPDATE,
    payload: { phase, total: phaseStats.get(phase).total, done: phaseStats.get(phase).done },
  }));

  const countsEvent = { event: EVENTS.COUNTS_UPDATE, payload: counts };

  return [...agentEvents, ...phaseEvents, countsEvent];
}

module.exports = { parseProgress };
