const { EventEmitter } = require('events');

const EVENTS = Object.freeze({
  AGENT_UPDATE: 'agent:update',
  EDGE_UPDATE: 'edge:update',
  JOURNAL_APPEND: 'journal:append',
  PHASE_UPDATE: 'phase:update',
  ANALYSIS_ADD: 'analysis:add',
  COUNTS_UPDATE: 'counts:update',
  LOG_UPDATE: 'log:update',
});

function createEventBus() {
  const ee = new EventEmitter();
  ee.setMaxListeners(50);
  return {
    emit(event, payload) {
      ee.emit(event, payload);
    },
    on(event, fn) {
      ee.on(event, fn);
      return () => ee.off(event, fn);
    },
    off(event, fn) {
      ee.off(event, fn);
    },
  };
}

module.exports = { createEventBus, EVENTS };
