const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { parseProgress } = require('../src/parsers/progress');

const FIXTURE_PATH = path.join(
  __dirname,
  'fixtures',
  '.voltron',
  'progress.json'
);
const STATUS_KEYS = ['queued', 'in_progress', 'completed', 'failed', 'blocked'];
const KNOWN_FIXTURE_PHASES = [
  'Phase 1: Audit',
  'Phase 2: Template edits',
  'Phase B: Live Smoke Test',
];

function loadFixtureRaw() {
  return fs.readFileSync(FIXTURE_PATH, 'utf8');
}

function loadFixtureParsed() {
  return JSON.parse(loadFixtureRaw());
}

test('parseProgress emits one AGENT_UPDATE per task in the fixture', () => {
  const raw = loadFixtureRaw();
  const parsed = JSON.parse(raw);
  const expectedCount = parsed.tasks.length;
  assert.ok(expectedCount > 0, 'fixture should contain at least one task');

  const events = parseProgress(raw);
  assert.ok(Array.isArray(events));

  const agentEvents = events.filter((e) => e.event === 'agent:update');
  assert.strictEqual(agentEvents.length, expectedCount);
});

test('at least one known fixture phase string appears in a PHASE_UPDATE', () => {
  const parsed = loadFixtureParsed();
  const events = parseProgress(parsed);

  const phaseEvents = events.filter((e) => e.event === 'phase:update');
  assert.ok(phaseEvents.length > 0, 'expected at least one phase:update event');

  const phaseSet = new Set(phaseEvents.map((e) => e.payload.phase));
  const matchedKnown = KNOWN_FIXTURE_PHASES.some((p) => phaseSet.has(p));
  assert.ok(
    matchedKnown,
    `expected at least one of ${JSON.stringify(KNOWN_FIXTURE_PHASES)} in ${JSON.stringify([...phaseSet])}`
  );

  for (const phaseEvent of phaseEvents) {
    const { total, done } = phaseEvent.payload;
    assert.strictEqual(typeof total, 'number', 'phase total should be numeric');
    assert.strictEqual(typeof done, 'number', 'phase done should be numeric');
    assert.ok(total >= 1, `phase total should be >= 1 (got ${total})`);
    assert.ok(done >= 0, `phase done should be >= 0 (got ${done})`);
  }
});

test('COUNTS_UPDATE tallies sum to the number of tasks with a recognized status', () => {
  const raw = loadFixtureRaw();
  const parsed = JSON.parse(raw);

  let expectedSum = 0;
  for (const task of parsed.tasks) {
    if (task && typeof task === 'object' && STATUS_KEYS.includes(task.status)) {
      expectedSum += 1;
    }
  }

  const events = parseProgress(raw);
  const countsEvents = events.filter((e) => e.event === 'counts:update');
  assert.strictEqual(
    countsEvents.length,
    1,
    'expected exactly one counts:update event'
  );

  const payload = countsEvents[0].payload;
  assert.deepStrictEqual(
    Object.keys(payload).sort(),
    [...STATUS_KEYS].sort(),
    'counts payload must have exactly the five expected keys'
  );
  for (const key of STATUS_KEYS) {
    assert.strictEqual(
      typeof payload[key],
      'number',
      `counts payload.${key} should be numeric`
    );
  }

  const actualSum = STATUS_KEYS.reduce((acc, k) => acc + payload[k], 0);
  assert.strictEqual(actualSum, expectedSum);
});

test('malformed JSON string returns []', () => {
  assert.deepStrictEqual(parseProgress('not json'), []);
});

test('null input returns []', () => {
  assert.deepStrictEqual(parseProgress(null), []);
});

test('object without tasks array returns []', () => {
  assert.deepStrictEqual(parseProgress({}), []);
  assert.deepStrictEqual(parseProgress({ tasks: 'nope' }), []);
});
