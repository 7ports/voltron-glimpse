const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLiveEdges, HUB_ID } = require('../src/model/edges');

test('hub id is the synthetic orchestrator', () => {
  assert.equal(HUB_ID, 'scrum-master');
});

test('one inferred dispatch spoke from the hub to each live agent (Map input)', () => {
  const live = new Map([
    ['committer-iso', { nodeId: 'committer-iso', agent: 'committer' }],
    ['route-adder-iso', { nodeId: 'route-adder-iso', agent: 'route-adder' }],
  ]);
  const edges = buildLiveEdges(live);
  assert.equal(edges.length, 2);
  for (const e of edges) {
    assert.equal(e.source, HUB_ID);
    assert.equal(e.kind, 'dispatch');
    assert.equal(e.inferred, true);
    assert.ok(['committer-iso', 'route-adder-iso'].includes(e.target));
    assert.equal(e.id, `${HUB_ID}->${e.target}`);
  }
});

test('accepts an array of entries', () => {
  const edges = buildLiveEdges([{ nodeId: 'A' }, { nodeId: 'B' }]);
  assert.deepEqual(edges.map((e) => e.target).sort(), ['A', 'B']);
});

test('accepts an array of plain nodeId strings', () => {
  const edges = buildLiveEdges(['A', 'B']);
  assert.deepEqual(edges.map((e) => e.target).sort(), ['A', 'B']);
});

test('accepts a plain object keyed by nodeId', () => {
  const edges = buildLiveEdges({ A: { nodeId: 'A' }, B: { nodeId: 'B' } });
  assert.deepEqual(edges.map((e) => e.target).sort(), ['A', 'B']);
});

test('empty live set yields no edges (hub only exists while >= 1 agent is live)', () => {
  assert.deepEqual(buildLiveEdges(new Map()), []);
  assert.deepEqual(buildLiveEdges([]), []);
  assert.deepEqual(buildLiveEdges({}), []);
});

test('non-iterable inputs are tolerated and return an empty edge set', () => {
  assert.deepEqual(buildLiveEdges(null), []);
  assert.deepEqual(buildLiveEdges(undefined), []);
});
