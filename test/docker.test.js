const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseDockerPs, pollDocker } = require('../src/docker');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'docker-ps.txt'), 'utf8');

test('parseDockerPs derives nodeId and agent from voltron container names', () => {
  const rows = parseDockerPs(FIXTURE);

  // Only the four `voltron-` rows survive; the non-voltron row is filtered out.
  assert.strictEqual(rows.length, 4);

  const byAgent = Object.fromEntries(rows.map((r) => [r.agent, r]));

  const fsdev = byAgent['fullstack-dev'];
  assert.ok(fsdev, 'fullstack-dev row present');
  assert.strictEqual(fsdev.nodeId, 'fullstack-dev-2026-06-09T17-01-06-ib387f');
  assert.strictEqual(fsdev.createdAt, '2026-06-09 17:01:06 +0000 UTC');
  assert.strictEqual(fsdev.state, 'running');

  assert.ok(byAgent['committer'], 'committer row present');
  assert.strictEqual(byAgent['committer'].nodeId, 'committer-2026-06-09T17-02-15-q9z2k1');

  assert.ok(byAgent['ui-designer'], 'ui-designer row present');
  assert.strictEqual(byAgent['ui-designer'].nodeId, 'ui-designer-2026-06-09T16-58-40-aa01bb');

  assert.ok(byAgent['typecheck-runner'], 'typecheck-runner row present');
  assert.strictEqual(byAgent['typecheck-runner'].nodeId, 'typecheck-runner-2026-06-09T17-03-30-zzz999');

  // nodeId never retains the voltron- prefix; createdAt always captured.
  for (const r of rows) {
    assert.ok(!r.nodeId.startsWith('voltron-'), `nodeId should drop voltron- prefix: ${r.nodeId}`);
    assert.ok(r.createdAt.length > 0, 'createdAt captured');
  }
});

test('pollDocker returns unavailable on exec failure without throwing', async () => {
  const result = await pollDocker({
    cwd: '/tmp',
    exec: () => {
      throw new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
    },
  });
  assert.deepStrictEqual(result, { available: false, containers: [] });
});

test('pollDocker returns parsed containers on exec success', async () => {
  const result = await pollDocker({ cwd: '/tmp', exec: () => FIXTURE });
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.containers.length, 4);
  assert.strictEqual(result.containers[0].agent, 'fullstack-dev');
});

test('pollDocker attaches podKey/podLabel and inspects once per id (caching)', async () => {
  let inspectCalls = 0;
  const inspectExec = (ids) => {
    inspectCalls += 1;
    return Promise.resolve(
      ids.map((id) => `${id}\t/host_mnt/c/work/voltron-glimpse`).join('\n')
    );
  };
  const podCache = new Map();
  const poll = () =>
    pollDocker({
      cwd: '/x',
      exec: () => FIXTURE,
      inspectExec,
      podCache,
      scope: { allPods: true },
    });

  const r1 = await poll();
  const r2 = await poll();

  assert.strictEqual(inspectCalls, 1, 'inspect runs once; second poll is all cache hits');
  const row = r1.containers.find((c) => c.agent === 'fullstack-dev');
  assert.strictEqual(row.podKey, 'c/work/voltron-glimpse');
  assert.strictEqual(row.podLabel, 'voltron-glimpse');
  assert.strictEqual(
    r2.containers.find((c) => c.agent === 'committer').podLabel,
    'voltron-glimpse'
  );
});

test('pollDocker marks podKey unknown when no /workspace mount resolves', async () => {
  const inspectExec = (ids) =>
    Promise.resolve(
      ids
        .map((id) => (id === '4c4c4c4c4c4c' ? `${id}\t` : `${id}\t/work/voltron-glimpse`))
        .join('\n')
    );
  const result = await pollDocker({
    cwd: '/x',
    exec: () => FIXTURE,
    inspectExec,
    podCache: new Map(),
    scope: { allPods: true },
  });
  const ui = result.containers.find((c) => c.agent === 'ui-designer');
  assert.strictEqual(ui.podKey, 'unknown');
  assert.strictEqual(ui.podLabel, 'unknown');
});
