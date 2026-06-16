'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createDockerLogTailer, buildLogsArgs } = require('../src/dockerLogs');

// Fake child process: stdout/stderr are EventEmitters; kill() flags + emits close
// so the tailer's own bookkeeping runs exactly as it would against a real child.
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = function () {
    child.killed = true;
    child.emit('close', null, 'SIGTERM');
    return true;
  };
  return child;
}

// Recording spawn stub: captures the args of every spawn and the children handed
// back, so tests can assert on command shape and drive stdout/stderr.
function makeSpawnStub() {
  const calls = [];
  const children = [];
  function spawn(args) {
    calls.push(args);
    const child = makeFakeChild();
    children.push(child);
    return child;
  }
  return { spawn, calls, children };
}

const C_A = { nodeId: 'A', id: 'id-aaa' };
const C_B = { nodeId: 'B', id: 'id-bbb' };

test('buildLogsArgs is a read-only `docker logs` invocation (never run/stop/rm/exec)', () => {
  const args = buildLogsArgs('id-xyz', 10);
  assert.deepStrictEqual(args, ['logs', '-f', '--tail', '10', 'id-xyz']);
  for (const verb of ['run', 'stop', 'rm', 'exec', 'kill', 'create', 'start']) {
    assert.ok(!args.includes(verb), `args must not contain mutating verb: ${verb}`);
  }
});

test('sync spawns one tail per live container with read-only args', () => {
  const stub = makeSpawnStub();
  const tailer = createDockerLogTailer({ spawn: stub.spawn, onActivity: () => {} });

  tailer.sync([C_A, C_B]);

  assert.strictEqual(stub.calls.length, 2);
  assert.strictEqual(stub.calls[0][0], 'logs');
  assert.strictEqual(stub.calls[1][0], 'logs');
  // container ids are passed through as the tail target
  const targets = stub.calls.map((a) => a[a.length - 1]).sort();
  assert.deepStrictEqual(targets, ['id-aaa', 'id-bbb']);
  assert.strictEqual(tailer.activeCount(), 2);
});

test('first stdout byte fires onActivity once and tears the tail down', () => {
  const stub = makeSpawnStub();
  const fired = [];
  const tailer = createDockerLogTailer({ spawn: stub.spawn, onActivity: (id) => fired.push(id) });

  tailer.sync([C_A]);
  const child = stub.children[0];
  child.stdout.emit('data', Buffer.from('thinking…\n'));
  // further chunks must NOT re-fire
  child.stdout.emit('data', Buffer.from('more output\n'));

  assert.deepStrictEqual(fired, ['A']);
  assert.ok(child.killed, 'tail child was killed after first activity');
  assert.strictEqual(tailer.activeCount(), 0);
});

test('stderr output also counts as activity', () => {
  const stub = makeSpawnStub();
  const fired = [];
  const tailer = createDockerLogTailer({ spawn: stub.spawn, onActivity: (id) => fired.push(id) });

  tailer.sync([C_A]);
  stub.children[0].stderr.emit('data', Buffer.from('warn: something\n'));

  assert.deepStrictEqual(fired, ['A']);
});

test('an empty chunk does not count as activity', () => {
  const stub = makeSpawnStub();
  const fired = [];
  const tailer = createDockerLogTailer({ spawn: stub.spawn, onActivity: (id) => fired.push(id) });

  tailer.sync([C_A]);
  stub.children[0].stdout.emit('data', Buffer.alloc(0));

  assert.deepStrictEqual(fired, []);
  assert.strictEqual(tailer.activeCount(), 1, 'tail stays open until real output arrives');
});

test('a signaled container is not re-tailed on subsequent syncs', () => {
  const stub = makeSpawnStub();
  const tailer = createDockerLogTailer({ spawn: stub.spawn, onActivity: () => {} });

  tailer.sync([C_A]);
  stub.children[0].stdout.emit('data', Buffer.from('go\n'));
  // A is still in the live set on the next poll — but we already advanced it.
  tailer.sync([C_A]);
  tailer.sync([C_A]);

  assert.strictEqual(stub.calls.length, 1, 'no re-spawn for an already-signaled container');
});

test('a container leaving the live set tears down its in-flight tail', () => {
  const stub = makeSpawnStub();
  const tailer = createDockerLogTailer({ spawn: stub.spawn, onActivity: () => {} });

  tailer.sync([C_A, C_B]);
  assert.strictEqual(tailer.activeCount(), 2);

  tailer.sync([C_A]); // B gone
  assert.ok(stub.children[1].killed, 'departed container B tail was killed');
  assert.strictEqual(tailer.activeCount(), 1);
});

test('a departed-then-returned silent container can be tailed again', () => {
  const stub = makeSpawnStub();
  const tailer = createDockerLogTailer({ spawn: stub.spawn, onActivity: () => {} });

  tailer.sync([C_A]); // tail #1 (no output yet)
  tailer.sync([]); // A gone -> tail killed, signaled cleared
  tailer.sync([C_A]); // A back -> fresh tail #2

  assert.strictEqual(stub.calls.length, 2);
});

test('close() kills every active tail', () => {
  const stub = makeSpawnStub();
  const tailer = createDockerLogTailer({ spawn: stub.spawn, onActivity: () => {} });

  tailer.sync([C_A, C_B]);
  tailer.close();

  assert.ok(stub.children[0].killed);
  assert.ok(stub.children[1].killed);
  assert.strictEqual(tailer.activeCount(), 0);
});

test('a child close event drops the tail without firing activity', () => {
  const stub = makeSpawnStub();
  const fired = [];
  const tailer = createDockerLogTailer({ spawn: stub.spawn, onActivity: (id) => fired.push(id) });

  tailer.sync([C_A]);
  // container exited with no output: docker logs -f closes on its own
  stub.children[0].emit('close', 0, null);

  assert.deepStrictEqual(fired, []);
  assert.strictEqual(tailer.activeCount(), 0);
});

test('spawn throwing (docker missing) degrades silently — no crash, no tail', () => {
  const tailer = createDockerLogTailer({
    spawn: () => {
      throw new Error('spawn docker ENOENT');
    },
    onActivity: () => {},
  });

  assert.doesNotThrow(() => tailer.sync([C_A]));
  assert.strictEqual(tailer.activeCount(), 0);
});

test('containers without an id are skipped (no spawn)', () => {
  const stub = makeSpawnStub();
  const tailer = createDockerLogTailer({ spawn: stub.spawn, onActivity: () => {} });

  tailer.sync([{ nodeId: 'X' }, { id: 'id-only' }, null]);

  assert.strictEqual(stub.calls.length, 0);
});
