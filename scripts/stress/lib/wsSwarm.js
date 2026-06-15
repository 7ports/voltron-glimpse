'use strict';

// T5 — WS client swarm. Opens N `WebSocket` *clients* from the already-installed
// `ws` package against ws://127.0.0.1:<port> (confirming, never bypassing, the
// localhost-only bind). Supports: drain (consume every frame), pause (stop
// reading so server-side bufferedAmount climbs — the V6 backpressure probe), and
// per-client frame accounting. No new dependency: `ws` ships a browser-compatible
// client.
const { WebSocket } = require('ws');

function makeClient(port, { onMessage } = {}) {
  const url = `ws://127.0.0.1:${port}`;
  const ws = new WebSocket(url);
  const client = {
    ws,
    url,
    frames: 0,
    snapshots: 0,
    patches: 0,
    paused: false,
    lastMessage: null,
    opened: false,
  };
  ws.on('message', (data) => {
    client.frames += 1;
    let msg = null;
    try {
      msg = JSON.parse(data.toString());
    } catch (_e) {
      /* ignore malformed (should never happen from our server) */
    }
    if (msg) {
      client.lastMessage = msg;
      if (msg.type === 'snapshot') client.snapshots += 1;
      else if (msg.type === 'patch') client.patches += 1;
    }
    if (typeof onMessage === 'function') onMessage(msg, client);
  });
  // Pause the receive side: the socket stops draining, so the server's
  // per-client bufferedAmount grows (no backpressure guard in safeSend) — exactly
  // the dead-consumer the V6 vector models. Uses the underlying net.Socket.
  client.pause = () => {
    if (ws._socket && typeof ws._socket.pause === 'function') {
      ws._socket.pause();
      client.paused = true;
    }
  };
  client.resume = () => {
    if (ws._socket && typeof ws._socket.resume === 'function') {
      ws._socket.resume();
      client.paused = false;
    }
  };
  client.bufferedAmount = () => ws.bufferedAmount;
  client.close = () =>
    new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', resolve);
      try {
        ws.terminate();
      } catch (_e) {
        resolve();
      }
    });
  return client;
}

// Open `n` clients and resolve once all are OPEN (or rejected on error).
function openSwarm(port, n, opts = {}) {
  const clients = [];
  const waits = [];
  for (let i = 0; i < n; i++) {
    const c = makeClient(port, opts);
    clients.push(c);
    waits.push(
      new Promise((resolve, reject) => {
        c.ws.once('open', () => {
          c.opened = true;
          resolve();
        });
        c.ws.once('error', reject);
      })
    );
  }
  return Promise.all(waits).then(() => clients);
}

async function closeSwarm(clients) {
  await Promise.all((clients || []).map((c) => c.close()));
}

module.exports = { makeClient, openSwarm, closeSwarm, WebSocket };
