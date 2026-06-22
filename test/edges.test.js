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

test('inferred child with a live parent yields a subdispatch edge to its parent, not the hub', () => {
  const live = new Map([
    ['fullstack-dev-iso', { nodeId: 'fullstack-dev-iso', agent: 'fullstack-dev' }],
    [
      'sub::toolu_01Vgq',
      {
        nodeId: 'sub::toolu_01Vgq',
        agent: 'test-writer',
        inferred: true,
        parentNodeId: 'fullstack-dev-iso',
        containerBacked: false,
      },
    ],
  ]);
  const edges = buildLiveEdges(live);

  // The real parent still gets its unchanged hub spoke.
  const hubSpoke = edges.find((e) => e.target === 'fullstack-dev-iso');
  assert.ok(hubSpoke, 'real parent should have a hub spoke');
  assert.equal(hubSpoke.source, HUB_ID);
  assert.equal(hubSpoke.kind, 'dispatch');
  assert.equal(hubSpoke.inferred, true);

  // The inferred child gets a subdispatch edge from its parent.
  const subEdge = edges.find((e) => e.target === 'sub::toolu_01Vgq');
  assert.ok(subEdge, 'inferred child should have a subdispatch edge');
  assert.equal(subEdge.source, 'fullstack-dev-iso');
  assert.equal(subEdge.kind, 'subdispatch');
  assert.equal(subEdge.inferred, true);
  assert.equal(subEdge.id, 'fullstack-dev-iso->sub::toolu_01Vgq');

  // The child has NO hub spoke.
  assert.equal(
    edges.filter((e) => e.source === HUB_ID && e.target === 'sub::toolu_01Vgq').length,
    0,
    'inferred child must not be attached to the hub'
  );
  assert.equal(edges.length, 2);
});

test('orphan inferred child (parent not in live set) yields no edge', () => {
  const live = new Map([
    [
      'sub::toolu_orphan',
      {
        nodeId: 'sub::toolu_orphan',
        agent: 'test-writer',
        inferred: true,
        parentNodeId: 'fullstack-dev-gone',
        containerBacked: false,
      },
    ],
  ]);
  const edges = buildLiveEdges(live);
  assert.deepEqual(edges, []);
});

test('orphan child does not regress real siblings; only the orphan is dropped', () => {
  const live = new Map([
    ['committer-iso', { nodeId: 'committer-iso', agent: 'committer' }],
    [
      'sub::toolu_orphan',
      {
        nodeId: 'sub::toolu_orphan',
        agent: 'test-writer',
        inferred: true,
        parentNodeId: 'absent-parent',
        containerBacked: false,
      },
    ],
  ]);
  const edges = buildLiveEdges(live);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].target, 'committer-iso');
  assert.equal(edges[0].source, HUB_ID);
  assert.equal(edges[0].kind, 'dispatch');
});

test('pure real-agent input is unchanged (no subdispatch regression)', () => {
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
    assert.equal(e.id, `${HUB_ID}->${e.target}`);
  }
});
