const { EVENTS } = require('./eventBus');

// Single in-memory source of truth for the LIVE set. The reconciler
// (src/liveness.js) emits agent:enter / agent:update / agent:exit and a full
// edge:update; this model folds those into a snapshot the WS layer broadcasts.
// See docs/live-monitor-redesign.md §5.1 (state.js → gut) and §2.4.
class StateModel {
  constructor() {
    this.liveAgents = {}; // nodeId -> live agent entry
    this.edges = [];
    this.dockerAvailable = false;
  }

  snapshot() {
    return {
      liveAgents: JSON.parse(JSON.stringify(this.liveAgents)),
      edges: this.edges.map((e) => ({ ...e })),
      dockerAvailable: this.dockerAvailable,
    };
  }

  applyEvent(eventName, payload) {
    // Any event MAY carry the current Docker availability; track it whenever present.
    if (payload && typeof payload.dockerAvailable === 'boolean') {
      this.dockerAvailable = payload.dockerAvailable;
    }

    switch (eventName) {
      case EVENTS.AGENT_ENTER: {
        if (!payload || !payload.nodeId) return null;
        const nodeId = payload.nodeId;
        this.liveAgents[nodeId] = { ...payload };
        return { type: 'enter', nodeId, agent: { ...this.liveAgents[nodeId] } };
      }
      case EVENTS.AGENT_UPDATE: {
        if (!payload || !payload.nodeId) return null;
        const nodeId = payload.nodeId;
        // Live model only merges into an existing agent; an update for an
        // unknown node (one we never saw enter) is ignored.
        if (!this.liveAgents[nodeId]) return null;
        this.liveAgents[nodeId] = { ...this.liveAgents[nodeId], ...payload };
        return { type: 'update', nodeId, agent: { ...this.liveAgents[nodeId] } };
      }
      case EVENTS.AGENT_EXIT: {
        if (!payload || !payload.nodeId) return null;
        const nodeId = payload.nodeId;
        delete this.liveAgents[nodeId];
        return { type: 'exit', nodeId };
      }
      case EVENTS.EDGE_UPDATE: {
        if (!payload) return null;
        if (Array.isArray(payload.edges)) {
          this.edges = payload.edges.map((e) => ({ ...e }));
        }
        return { type: 'edges', edges: this.edges.map((e) => ({ ...e })) };
      }
      default:
        return null;
    }
  }
}

module.exports = { StateModel };
