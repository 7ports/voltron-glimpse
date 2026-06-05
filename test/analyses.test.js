const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { indexAnalysis, readAnalysis } = require('../src/parsers/analyses');
const { EVENTS } = require('../src/eventBus');

const analysesDir = path.join(__dirname, 'fixtures', '.voltron', 'analyses');

function discoverFixturePath() {
  const entries = fs.readdirSync(analysesDir);
  const mdFile = entries.find((name) => name.endsWith('.md'));
  if (!mdFile) {
    throw new Error('No .md fixture found in ' + analysesDir);
  }
  return path.join(analysesDir, mdFile);
}

test('indexAnalysis emits analysis:add with topic/timestamp/title from filename + first heading', () => {
  const fixturePath = discoverFixturePath();
  const result = indexAnalysis(fixturePath);

  assert.strictEqual(result.event, EVENTS.ANALYSIS_ADD);
  assert.strictEqual(result.payload.path, fixturePath);
  assert.ok(typeof result.payload.topic === 'string' && result.payload.topic.length > 0);
  assert.ok(typeof result.payload.timestamp === 'string' && result.payload.timestamp.length > 0);
  assert.ok(typeof result.payload.title === 'string' && result.payload.title.length > 0);
  assert.ok(typeof result.payload.id === 'string' && result.payload.id.length > 0);
});

test('readAnalysis returns the full file content', () => {
  const fixturePath = discoverFixturePath();
  const expected = fs.readFileSync(fixturePath, 'utf8');
  const actual = readAnalysis(fixturePath);
  assert.strictEqual(actual, expected);
});
