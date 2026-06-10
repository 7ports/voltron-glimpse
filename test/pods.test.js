const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizePodPath,
  podLabelFor,
  resolvePods,
  selectPods,
} = require('../src/pods');

test('normalizePodPath collapses Windows / Docker-Desktop variants to one key', () => {
  const forms = [
    'C:\\work\\projA',
    '/host_mnt/c/work/projA',
    '//host_mnt/c/work/projA',
    '/c/work/projA',
    'c:/work/projA',
  ];
  for (const f of forms) {
    assert.strictEqual(normalizePodPath(f), 'c/work/proja', `form ${f}`);
  }
  assert.strictEqual(normalizePodPath('/home/user/proj'), '/home/user/proj');
  assert.strictEqual(normalizePodPath(''), '');
  assert.strictEqual(normalizePodPath(null), '');
});

test('podLabelFor returns basename; unknown stays unknown', () => {
  assert.strictEqual(podLabelFor('c/work/voltron-glimpse'), 'voltron-glimpse');
  assert.strictEqual(podLabelFor('/work/myproj'), 'myproj');
  assert.strictEqual(podLabelFor('unknown'), 'unknown');
  assert.strictEqual(podLabelFor(''), 'unknown');
});

test('resolvePods inspects once per id and caches for its lifetime', async () => {
  let calls = 0;
  const exec = (ids) => {
    calls += 1;
    return Promise.resolve(ids.map((id) => `${id}\t/work/myproj`).join('\n'));
  };
  const cache = new Map();
  const containers = [{ id: 'x1', agent: 'a' }];
  const r1 = await resolvePods(containers, { exec, cache });
  const r2 = await resolvePods(containers, { exec, cache });
  assert.strictEqual(calls, 1, 'second poll is a cache hit, no re-inspect');
  assert.strictEqual(r1[0].podKey, '/work/myproj');
  assert.strictEqual(r1[0].podLabel, 'myproj');
  assert.strictEqual(r2[0].podLabel, 'myproj');
});

test('resolvePods marks unknown on empty mount and evicts gone ids', async () => {
  const exec = (ids) => Promise.resolve(ids.map((id) => `${id}\t`).join('\n'));
  const cache = new Map();
  const r = await resolvePods([{ id: 'g1' }], { exec, cache });
  assert.strictEqual(r[0].podKey, 'unknown');
  assert.strictEqual(r[0].podLabel, 'unknown');
  assert.strictEqual(cache.size, 1);
  await resolvePods([{ id: 'h1' }], { exec, cache });
  assert.ok(!cache.has('g1'), 'gone id evicted from cache');
});

test('resolvePods never throws when inspect rejects', async () => {
  const exec = () => Promise.reject(new Error('daemon down'));
  const r = await resolvePods([{ id: 'z1', agent: 'q' }], { exec, cache: new Map() });
  assert.strictEqual(r[0].podKey, 'unknown');
  assert.strictEqual(r[0].podLabel, 'unknown');
});

test('selectPods scopes to self pod by default (plus unknowns)', () => {
  const rows = [
    { id: 'a1', podKey: normalizePodPath('/host_mnt/c/work/projA'), podLabel: 'proja' },
    { id: 'b1', podKey: normalizePodPath('/host_mnt/c/work/projB'), podLabel: 'projb' },
    { id: 'u1', podKey: 'unknown', podLabel: 'unknown' },
  ];
  const selfA = 'C:\\work\\projA'; // windows-ish form proves normalization
  const def = selectPods(rows, {}, selfA);
  assert.deepStrictEqual(def.map((r) => r.id).sort(), ['a1', 'u1']);
  assert.strictEqual(def.find((r) => r.id === 'a1').selfPod, true);
  assert.strictEqual(def.find((r) => r.id === 'u1').selfPod, false);
});

test('selectPods --all-pods keeps every pod', () => {
  const rows = [
    { id: 'a1', podKey: 'c/work/proja', podLabel: 'proja' },
    { id: 'b1', podKey: 'c/work/projb', podLabel: 'projb' },
    { id: 'u1', podKey: 'unknown', podLabel: 'unknown' },
  ];
  const all = selectPods(rows, { allPods: true }, 'c/work/proja');
  assert.strictEqual(all.length, 3);
  assert.strictEqual(all.find((r) => r.id === 'a1').selfPod, true);
});

test('selectPods --pod B keeps only the requested pod', () => {
  const rows = [
    { id: 'a1', podKey: 'c/work/proja', podLabel: 'proja' },
    { id: 'b1', podKey: 'c/work/projb', podLabel: 'projb' },
    { id: 'u1', podKey: 'unknown', podLabel: 'unknown' },
  ];
  const onlyB = selectPods(rows, { pods: ['projB'] }, 'c/work/proja');
  assert.deepStrictEqual(onlyB.map((r) => r.id), ['b1']);
});
