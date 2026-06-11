const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizePodPath,
  toHostPath,
  podLabelFor,
  podKeyMatches,
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

test('normalizePodPath collapses ALL five encodings of one root to one key', () => {
  const forms = [
    'C:\\work\\proj', // windows
    '/c/work/proj', // msys / git-bash
    '/host_mnt/c/work/proj', // docker-desktop (linux backend)
    '/mnt/c/work/proj', // wsl2 drive mount
    '/run/desktop/mnt/host/c/work/proj', // docker-desktop (wsl2 backend)
  ];
  const keys = forms.map(normalizePodPath);
  for (let i = 0; i < keys.length; i += 1) {
    assert.strictEqual(keys[i], 'c/work/proj', `form ${forms[i]} -> ${keys[i]}`);
  }
  // case-insensitive on the drive letter
  assert.strictEqual(normalizePodPath('/mnt/C/Work/Proj'), 'c/work/proj');
  // any two encodings match each other
  assert.ok(podKeyMatches('/mnt/c/work/proj', '/host_mnt/c/work/proj'));
  assert.ok(podKeyMatches('/run/desktop/mnt/host/c/work/proj', 'C:\\work\\proj'));
  // genuine multi-segment linux mount is NOT mistaken for a drive mount
  assert.strictEqual(normalizePodPath('/mnt/data/proj'), '/mnt/data/proj');
});

test('toHostPath translates every drive encoding to a real C:\\ path on a Windows host', () => {
  const forms = [
    '/host_mnt/c/work/proj', // docker-desktop (linux backend)
    '/mnt/c/work/proj', // wsl2 drive mount
    '/run/desktop/mnt/host/c/work/proj', // docker-desktop (wsl2 backend)
    'c:/work/proj', // windows drive (already)
    'C:\\work\\proj', // windows backslash
    '/c/work/proj', // msys / git-bash
  ];
  for (const f of forms) {
    assert.strictEqual(toHostPath(f, 'win32'), 'C:\\work\\proj', `form ${f}`);
  }
  // drive-root with no remainder
  assert.strictEqual(toHostPath('/mnt/c', 'win32'), 'C:\\');
});

test('toHostPath passes genuine Linux paths through unchanged on a POSIX host', () => {
  assert.strictEqual(toHostPath('/home/user/proj', 'linux'), '/home/user/proj');
  assert.strictEqual(toHostPath('/mnt/data/proj', 'linux'), '/mnt/data/proj'); // NOT a drive mount
  assert.strictEqual(toHostPath('/srv/voltron/app', 'linux'), '/srv/voltron/app');
  // a genuine Linux path is left as-is on Windows too (can't be read there anyway)
  assert.strictEqual(toHostPath('/home/user/proj', 'win32'), '/home/user/proj');
});

test('toHostPath maps a drive encoding to the WSL2 /mnt view on a POSIX host', () => {
  assert.strictEqual(toHostPath('/host_mnt/c/work/proj', 'linux'), '/mnt/c/work/proj');
  assert.strictEqual(toHostPath('/run/desktop/mnt/host/c/work/proj', 'linux'), '/mnt/c/work/proj');
  assert.strictEqual(toHostPath('/mnt/c/work/proj', 'linux'), '/mnt/c/work/proj');
  assert.strictEqual(toHostPath('C:\\work\\proj', 'linux'), '/mnt/c/work/proj');
});

test('toHostPath returns empty for non-string / empty input', () => {
  assert.strictEqual(toHostPath(null, 'win32'), '');
  assert.strictEqual(toHostPath('', 'win32'), '');
  assert.strictEqual(toHostPath(undefined, 'linux'), '');
});

test('resolvePods surfaces a host-readable podRoot for each container', async () => {
  const exec = (ids) => Promise.resolve(ids.map((id) => `${id}\t/host_mnt/c/work/proj`).join('\n'));
  const r = await resolvePods([{ id: 'p1', agent: 'a' }], { exec, cache: new Map() });
  // podKey is the lossy canonical key; podRoot is the host-readable path.
  assert.strictEqual(r[0].podKey, 'c/work/proj');
  assert.strictEqual(typeof r[0].podRoot, 'string');
  assert.ok(r[0].podRoot.length > 0);
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

test('self container in a DIFFERENT encoding is tagged selfPod and kept under default scope', () => {
  // Launch root observed as WSL2 (/mnt/c/..); the SAME project's container
  // mount-source comes back from docker inspect as docker-desktop (/host_mnt/c/..).
  const selfRoot = '/mnt/c/work/proj'; // how the CLI stringifies its own root
  const rows = [
    { id: 'self1', podKey: normalizePodPath('/host_mnt/c/work/proj'), podLabel: 'proj' },
    { id: 'other1', podKey: normalizePodPath('/host_mnt/c/work/other'), podLabel: 'other' },
  ];
  const def = selectPods(rows, {}, selfRoot);
  const self = def.find((r) => r.id === 'self1');
  assert.ok(self, 'self container must NOT be dropped under default scope');
  assert.strictEqual(self.selfPod, true, 'self container tagged selfPod despite different encoding');
  assert.ok(!def.find((r) => r.id === 'other1'), 'foreign pod dropped under default scope');
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
