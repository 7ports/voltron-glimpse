const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseBeadList, loadBeads } = require('../src/parsers/beads');
const { EVENTS } = require('../src/eventBus');

test('parseBeadList emits an EDGE_UPDATE with declared:true for each dependency', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'bd-list.json');
  const raw = fs.readFileSync(fixturePath, 'utf8');
  const events = parseBeadList(raw);

  assert.ok(Array.isArray(events), 'parseBeadList must return an array');
  assert.ok(events.length > 0, 'parseBeadList must emit at least one event for non-empty fixture');

  const edges = events.filter((e) => e.event === EVENTS.EDGE_UPDATE);
  assert.ok(edges.length >= 1, 'expected at least one EDGE_UPDATE event');

  const sample = edges[0];
  assert.equal(sample.payload.declared, true, 'edge payload.declared must be true');
  assert.equal(sample.payload.kind, 'dependency', 'edge payload.kind must be "dependency"');
  assert.equal(typeof sample.payload.from, 'string', 'edge payload.from must be a string');
  assert.equal(typeof sample.payload.to, 'string', 'edge payload.to must be a string');
  assert.ok(sample.payload.from.length > 0, 'edge payload.from must be non-empty');
  assert.ok(sample.payload.to.length > 0, 'edge payload.to must be non-empty');
});

test('loadBeads returns [] without throwing when exec impl errors (bd missing)', () => {
  let result;
  assert.doesNotThrow(() => {
    result = loadBeads('.', () => {
      throw new Error('bd not found');
    });
  });
  assert.deepEqual(result, [], 'loadBeads must return [] when exec impl throws');
});
