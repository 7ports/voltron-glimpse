const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEdges } = require('../src/model/edges');

test('star edges from a Tier-1 orchestrator to each other node', () => {
  const nodes = [
    { id: 'scrum-master-iso', agent: 'scrum-master', startedAt: '2026-06-05T10:00:00Z' },
    { id: 'committer-iso',    agent: 'committer',    startedAt: '2026-06-05T10:00:05Z' },
    { id: 'route-adder-iso',  agent: 'route-adder',  startedAt: '2026-06-05T10:00:06Z' },
  ];
  const edges = buildEdges(nodes, []);
  const dispatch = edges.filter((e) => e.kind === 'dispatch');
  assert.equal(dispatch.length, 2);
  for (const e of dispatch) {
    assert.equal(e.from, 'scrum-master-iso');
    assert.equal(e.inferred, true);
    assert.ok(['committer-iso', 'route-adder-iso'].includes(e.to));
  }
});

test('nodes started within 3s share a batch group id; nodes outside the window do not', () => {
  const nodes = [
    { id: 'sm',  agent: 'scrum-master',     startedAt: '2026-06-05T10:00:00Z' },
    { id: 'a',   agent: 'committer',        startedAt: '2026-06-05T10:00:05Z' },
    { id: 'b',   agent: 'route-adder',      startedAt: '2026-06-05T10:00:06Z' },
    { id: 'c',   agent: 'typecheck-runner', startedAt: '2026-06-05T10:00:30Z' },
  ];
  const edges = buildEdges(nodes, []);
  const byTo = Object.fromEntries(
    edges.filter((e) => e.kind === 'dispatch').map((e) => [e.to, e])
  );
  assert.ok(byTo.a && byTo.a.batchGroup);
  assert.ok(byTo.b && byTo.b.batchGroup);
  assert.ok(byTo.c && byTo.c.batchGroup);
  assert.equal(byTo.a.batchGroup, byTo.b.batchGroup, 'a and b are within 3s');
  assert.notEqual(byTo.a.batchGroup, byTo.c.batchGroup, 'c is far outside the window');
});

test('declared dependency edges come straight from beadDeps', () => {
  const nodes = [
    { id: 'task-a', agent: 'fullstack-dev', startedAt: '2026-06-05T10:00:00Z' },
    { id: 'task-b', agent: 'qa-tester',     startedAt: '2026-06-05T10:00:01Z' },
  ];
  const beadDeps = [{ from: 'task-a', to: 'task-b' }];
  const edges = buildEdges(nodes, beadDeps);
  const deps = edges.filter((e) => e.kind === 'dependency');
  assert.equal(deps.length, 1);
  assert.equal(deps[0].from, 'task-a');
  assert.equal(deps[0].to, 'task-b');
  assert.equal(deps[0].declared, true);
});

test('falls back to earliest-started node when no Tier-1 orchestrator is present', () => {
  const nodes = [
    { id: 'second', agent: 'committer',        startedAt: '2026-06-05T10:00:10Z' },
    { id: 'first',  agent: 'route-adder',      startedAt: '2026-06-05T10:00:00Z' },
    { id: 'third',  agent: 'typecheck-runner', startedAt: '2026-06-05T10:00:20Z' },
  ];
  const edges = buildEdges(nodes, []);
  const dispatch = edges.filter((e) => e.kind === 'dispatch');
  assert.equal(dispatch.length, 2);
  for (const e of dispatch) {
    assert.equal(e.from, 'first');
  }
});

test('empty node array yields no dispatch edges', () => {
  assert.deepEqual(buildEdges([], []), []);
});

test('non-array inputs are tolerated and return an empty edge set', () => {
  assert.deepEqual(buildEdges(null, null), []);
  assert.deepEqual(buildEdges(undefined, undefined), []);
});
