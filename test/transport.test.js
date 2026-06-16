const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const { createHttpServer } = require('../src/transport/httpServer');
const { createWsServer, safeSend, MAX_BUFFERED_BYTES } = require('../src/transport/wsServer');
const { StateModel } = require('../src/state');
const { createEventBus, EVENTS } = require('../src/eventBus');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function getPath(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'GET',
        headers: { Connection: 'close' },
        agent: false,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Buffers all ws messages from the moment the WebSocket is created so that messages
// arriving in the same tick as 'open' are not lost.
function createCollector(ws) {
  const buffer = [];
  const waiters = [];
  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch (_e) { return; }
    buffer.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.predicate(msg)) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });
  return {
    wait(predicate, timeoutMs = 2000) {
      const existing = buffer.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const w = { predicate, resolve, timer: null };
        w.timer = setTimeout(() => {
          const idx = waiters.indexOf(w);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error('timeout waiting for ws message'));
        }, timeoutMs);
        waiters.push(w);
      });
    },
  };
}

async function shutdownHttp(server) {
  try { server.closeAllConnections(); } catch (_e) { /* older Node fallback */ }
  await new Promise((r) => server.close(() => r()));
}

test('httpServer serves index.html from publicDir on GET / with 200', { timeout: 5000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-transport-'));
  fs.writeFileSync(path.join(tmp, 'index.html'), '<html><body>ok</body></html>');
  const server = createHttpServer(tmp);
  t.after(async () => {
    await shutdownHttp(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const addr = await listen(server);
  const res = await getPath(addr.port, '/');
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('ok'));
});

test('wsServer sends a snapshot on connect and broadcasts patches on bus events', { timeout: 5000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-transport-ws-'));
  fs.writeFileSync(path.join(tmp, 'index.html'), '<html></html>');
  const server = createHttpServer(tmp);
  const state = new StateModel();
  state.applyEvent(EVENTS.AGENT_ENTER, { nodeId: 'a1', agent: 'planner', state: 'working' });
  const bus = createEventBus();
  const wsCtx = createWsServer(server, state, bus);
  let ws;

  t.after(async () => {
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise((r) => {
        ws.once('close', () => r());
        try { ws.terminate(); } catch (_e) { r(); }
      });
    }
    await new Promise((r) => wsCtx.close(() => r()));
    await shutdownHttp(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const addr = await listen(server);
  ws = new WebSocket(`ws://127.0.0.1:${addr.port}`);
  // Attach message collector BEFORE awaiting 'open' so a snapshot arriving in the
  // same tick as 'open' is captured rather than dropped.
  const collector = createCollector(ws);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const snap = await collector.wait((m) => m.type === 'snapshot');
  assert.ok(snap.state, 'snapshot should include state');
  assert.ok(
    snap.state.liveAgents && snap.state.liveAgents.a1,
    'snapshot should contain pre-seeded live agent'
  );

  const patchPromise = collector.wait((m) => m.type === 'patch' && m.event === EVENTS.AGENT_ENTER);
  bus.emit(EVENTS.AGENT_ENTER, { nodeId: 'a2', agent: 'fullstack', state: 'dispatching' });
  const patch = await patchPromise;
  assert.strictEqual(patch.event, EVENTS.AGENT_ENTER);
  assert.deepStrictEqual(patch.payload, { nodeId: 'a2', agent: 'fullstack', state: 'dispatching' });
});

// Minimal stand-in for a ws client so we can drive bufferedAmount/readyState
// directly without a real socket.
function makeMockClient(bufferedAmount) {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount,
    sent: [],
    terminated: false,
    send(data) { this.sent.push(data); },
    terminate() { this.terminated = true; this.readyState = WebSocket.CLOSING; },
  };
}

test('safeSend drops a backpressured client without starving a healthy one', () => {
  const healthy = makeMockClient(0);
  const slow = makeMockClient(MAX_BUFFERED_BYTES + 1);
  const msg = { type: 'patch', event: 'agent:enter', payload: { nodeId: 'a1' } };

  // Broadcast to both, mixed order, just as the per-event loop would.
  safeSend(healthy, msg);
  safeSend(slow, msg);

  // Healthy client received the message and was left open.
  assert.strictEqual(healthy.sent.length, 1, 'healthy client should receive the message');
  assert.deepStrictEqual(JSON.parse(healthy.sent[0]), msg);
  assert.strictEqual(healthy.terminated, false, 'healthy client should not be terminated');

  // Slow client was terminated and never enqueued anything (no unbounded buffering).
  assert.strictEqual(slow.sent.length, 0, 'backpressured client should not be sent to');
  assert.strictEqual(slow.terminated, true, 'backpressured client should be terminated');
});

test('safeSend never buffers for a stuck consumer across repeated broadcasts', () => {
  const slow = makeMockClient(MAX_BUFFERED_BYTES + 1);
  for (let i = 0; i < 1000; i++) {
    safeSend(slow, { type: 'patch', event: 'agent:update', payload: { i } });
  }
  // Not a single byte enqueued despite 1000 broadcasts → memory cannot grow unbounded.
  assert.strictEqual(slow.sent.length, 0, 'stuck consumer must accumulate nothing');
  assert.strictEqual(slow.terminated, true);
});

test('safeSend sends to a client exactly at the threshold (boundary)', () => {
  const atLimit = makeMockClient(MAX_BUFFERED_BYTES);
  safeSend(atLimit, { type: 'patch', event: 'agent:enter', payload: {} });
  assert.strictEqual(atLimit.sent.length, 1, 'client at (not over) threshold should still receive');
  assert.strictEqual(atLimit.terminated, false);
});

test('httpServer returns 404 for unknown paths', { timeout: 5000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-transport-404-'));
  fs.writeFileSync(path.join(tmp, 'index.html'), '<html></html>');
  const server = createHttpServer(tmp);
  t.after(async () => {
    await shutdownHttp(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const addr = await listen(server);
  const res = await getPath(addr.port, '/nope.html');
  assert.strictEqual(res.status, 404);
});
