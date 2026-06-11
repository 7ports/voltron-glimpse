const test = require('node:test');
const assert = require('node:assert/strict');
const { getTier, TIER_MAP } = require('../src/model/tiers');

test('getTier returns 1 for a Tier 1 agent (scrum-master)', () => {
  assert.equal(getTier('scrum-master'), 1);
});

test('getTier returns 2 for a Tier 2 agent (fullstack-dev)', () => {
  assert.equal(getTier('fullstack-dev'), 2);
});

test('getTier returns 3 for an unknown agent (default)', () => {
  assert.equal(getTier('totally-unknown-agent'), 3);
});

test('getTier returns 3 for known Tier 3 micro-agents', () => {
  assert.equal(getTier('committer'), 3);
  assert.equal(getTier('route-adder'), 3);
});

test('getTier returns 3 for invalid input (null, undefined, empty)', () => {
  assert.equal(getTier(null), 3);
  assert.equal(getTier(undefined), 3);
  assert.equal(getTier(''), 3);
});

test('TIER_MAP is exported and contains expected Tier-1 / Tier-2 entries', () => {
  assert.equal(TIER_MAP['scrum-master'], 1);
  assert.equal(TIER_MAP['code-analyst'], 1);
  assert.equal(TIER_MAP['fullstack-dev'], 2);
  assert.equal(TIER_MAP['qa-tester'], 2);
});
