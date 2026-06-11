const { WebSocketServer, WebSocket } = require('ws');
const { EVENTS } = require('../eventBus');

function safeSend(client, payload) {
  if (client.readyState !== WebSocket.OPEN) return;
  try {
    client.send(JSON.stringify(payload));
  } catch (_err) {
    // ignore individual client send failures; don't crash broadcast
  }
}

function createWsServer(httpServer, stateModel, bus) {
  if (!httpServer) throw new Error('createWsServer: httpServer is required');
  if (!stateModel || typeof stateModel.snapshot !== 'function') {
    throw new Error('createWsServer: stateModel with snapshot() is required');
  }
  if (!bus || typeof bus.on !== 'function') {
    throw new Error('createWsServer: bus with on() is required');
  }

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (client) => {
    safeSend(client, { type: 'snapshot', state: stateModel.snapshot() });
  });

  const unsubscribers = [];
  for (const eventName of Object.values(EVENTS)) {
    const off = bus.on(eventName, (payload) => {
      const message = {
        type: 'patch',
        event: eventName,
        payload: payload === undefined ? null : payload,
      };
      for (const client of wss.clients) {
        safeSend(client, message);
      }
    });
    unsubscribers.push(off);
  }

  function close(cb) {
    for (const off of unsubscribers) {
      try {
        off();
      } catch (_e) {
        // ignore
      }
    }
    unsubscribers.length = 0;
    wss.close(cb);
  }

  return { wss, close };
}

module.exports = { createWsServer };
