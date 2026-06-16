'use strict';

const path = require('node:path');

// Spin up a real Glimpse backend in-process: the SAME bus → state → reconciler →
// wsServer → httpServer wiring as bin/cli.js, bound to 127.0.0.1 on an ephemeral
// port. We drive the reconciler directly (fake docker polls / log events) so the
// WS broadcast path (S5/S6/S9) is exercised end-to-end without a real daemon. The
// HTTP server serves the real public/ so a browser can attach for S8 if desired.
const { createEventBus, EVENTS } = require('../../../src/eventBus');
const { StateModel } = require('../../../src/state');
const { createHttpServer } = require('../../../src/transport/httpServer');
const { createWsServer } = require('../../../src/transport/wsServer');
const { createReconciler } = require('../../../src/liveness');

const PUBLIC_DIR = path.join(__dirname, '..', '..', '..', 'public');
const HOST = '127.0.0.1';

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    function onErr(e) {
      server.removeListener('listening', onOk);
      reject(e);
    }
    function onOk() {
      server.removeListener('error', onErr);
      resolve();
    }
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, host);
  });
}

async function startServer({ reconcilerOpts } = {}) {
  const bus = createEventBus();
  const state = new StateModel();
  for (const ev of Object.values(EVENTS)) {
    bus.on(ev, (payload) => state.applyEvent(ev, payload));
  }
  const reconciler = createReconciler({ bus, ...(reconcilerOpts || {}) });
  const httpServer = createHttpServer(PUBLIC_DIR);
  const wsServer = createWsServer(httpServer, state, bus);
  await listen(httpServer, 0, HOST); // ephemeral port, localhost-only
  const addr = httpServer.address();
  const port = addr.port;

  function close() {
    return new Promise((resolve) => {
      try {
        wsServer.close(() => {
          httpServer.close(() => resolve());
        });
      } catch (_e) {
        try {
          httpServer.close(() => resolve());
        } catch (_e2) {
          resolve();
        }
      }
    });
  }

  return { bus, state, reconciler, httpServer, wsServer, port, host: HOST, address: addr, close, EVENTS };
}

module.exports = { startServer, HOST, PUBLIC_DIR };
