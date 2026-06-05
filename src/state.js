const { EVENTS } = require('./eventBus');

class StateModel {
  constructor() {
    this.agents = {};
    this.edges = [];
    this.phases = {};
    this.journal = [];
    this.analyses = [];
    this.counts = {};
  }

  snapshot() {
    return {
      agents: JSON.parse(JSON.stringify(this.agents)),
      edges: this.edges.map((e) => ({ ...e })),
      phases: JSON.parse(JSON.stringify(this.phases)),
      journal: this.journal.slice(),
      analyses: this.analyses.slice(),
      counts: { ...this.counts },
    };
  }

  applyEvent(eventName, payload) {
    switch (eventName) {
      case EVENTS.AGENT_UPDATE: {
        if (!payload || !payload.id) return null;
        const id = payload.id;
        this.agents[id] = { ...(this.agents[id] || {}), ...payload };
        return { type: 'agent', id, agent: { ...this.agents[id] } };
      }
      case EVENTS.EDGE_UPDATE: {
        if (!payload || !payload.id) return null;
        const idx = this.edges.findIndex((e) => e.id === payload.id);
        if (idx >= 0) {
          this.edges[idx] = { ...this.edges[idx], ...payload };
        } else {
          this.edges.push({ ...payload });
        }
        return { type: 'edge', edge: { ...payload } };
      }
      case EVENTS.JOURNAL_APPEND: {
        if (!payload) return null;
        this.journal.push(payload);
        return { type: 'journal', entry: payload };
      }
      case EVENTS.PHASE_UPDATE: {
        if (!payload || !payload.id) return null;
        const id = payload.id;
        this.phases[id] = { ...(this.phases[id] || {}), ...payload };
        return { type: 'phase', id, phase: { ...this.phases[id] } };
      }
      case EVENTS.ANALYSIS_ADD: {
        if (!payload) return null;
        this.analyses.push(payload);
        return { type: 'analysis', analysis: payload };
      }
      case EVENTS.COUNTS_UPDATE: {
        if (!payload) return null;
        this.counts = { ...this.counts, ...payload };
        return { type: 'counts', counts: { ...this.counts } };
      }
      case EVENTS.LOG_UPDATE: {
        if (!payload) return null;
        const agentId = payload.agentId;
        if (agentId && this.agents[agentId] && payload.line) {
          const logs = this.agents[agentId].logs || [];
          this.agents[agentId] = {
            ...this.agents[agentId],
            logs: logs.concat([payload.line]),
          };
        }
        return { type: 'log', agentId: agentId || null, line: payload.line || null };
      }
      default:
        return null;
    }
  }
}

module.exports = { StateModel };
