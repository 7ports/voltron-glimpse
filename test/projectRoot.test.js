const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const { resolveProjectRoot } = require('../src/projectRoot');

test('resolveProjectRoot finds nearest ancestor containing .voltron/', () => {
  const startDir = path.join(__dirname, 'fixtures', '.voltron', 'logs');
  const expected = path.join(__dirname, 'fixtures');
  assert.strictEqual(resolveProjectRoot(startDir), expected);
});

test('resolveProjectRoot finds fixtures dir from the fixtures dir itself', () => {
  const startDir = path.join(__dirname, 'fixtures');
  const expected = path.join(__dirname, 'fixtures');
  assert.strictEqual(resolveProjectRoot(startDir), expected);
});

test('resolveProjectRoot returns null when no .voltron ancestor exists', () => {
  const synthetic = path.join(os.tmpdir(), 'voltron-glimpse-no-such-dir-' + process.pid);
  assert.strictEqual(resolveProjectRoot(synthetic), null);
});

test('resolveProjectRoot returns null for null input', () => {
  assert.strictEqual(resolveProjectRoot(null), null);
});
