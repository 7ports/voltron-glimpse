const { WebSocketServer, WebSocket } = require('ws');
const { EVENTS } = require('../eventBus');

// Backpressure cap: if a client's unflushed outbound buffer exceeds this, it is a
// stuck/dead consumer. Terminate it rather than let bufferedAmount grow without
// bound and balloon server RSS. Patch/snapshot envelopes are small JSON, so 1 MiB
// is far above any healthy steady state yet bounds the worst case per-client.
const MAX_BUFFERED_BYTES = 1024 * 1024; // 1 MiB

function safeSend(client, payload) {
  if (client.readyState !== WebSocket.OPEN) return;
  // Drop a backpressured consumer before sending so one slow/dead client cannot
  // accumulate unbounded buffer; healthy clients keep receiving normally.
  if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
    try {
      client.terminate();
    } catch (_err) {
      // ignore terminate failures; don't crash broadcast
    }
    return;
  }
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

module.exports = { createWsServer, safeSend, MAX_BUFFERED_BYTES };
