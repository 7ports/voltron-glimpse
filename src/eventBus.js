const { EventEmitter } = require('events');

const EVENTS = Object.freeze({
  AGENT_ENTER: 'agent:enter',
  AGENT_UPDATE: 'agent:update',
  AGENT_EXIT: 'agent:exit',
  EDGE_UPDATE: 'edge:update',
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
