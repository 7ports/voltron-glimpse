const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { parseLog } = require('../src/parsers/logs');

const FIX_DIR = path.join(__dirname, 'fixtures', '.voltron', 'logs');

function readFixture(name) {
  return fs.readFileSync(path.join(FIX_DIR, name), 'utf8');
}

test('parseLog: mines dispatch:start/end markers from structured tool_use/tool_result', () => {
  const file = 'submanager-dispatch.log';
  const p = parseLog(readFixture(file), file);
  assert.ok(p, 'should return a payload');
  assert.ok(Array.isArray(p.dispatches), 'dispatches must be an array');

  const starts = p.dispatches.filter((d) => d.kind === 'dispatch:start');
  const ends = p.dispatches.filter((d) => d.kind === 'dispatch:end');

  // Fixture: 2 Agent dispatches (config-editor completed, readme-section-writer
  // in-flight); exactly one tool_result (for config-editor).
  assert.strictEqual(starts.length, 2, 'exactly 2 dispatch:start markers');
  assert.strictEqual(ends.length, 1, 'exactly 1 dispatch:end marker');

  const configStart = starts.find((d) => d.childAgent === 'config-editor');
  const readmeStart = starts.find((d) => d.childAgent === 'readme-section-writer');
  assert.ok(configStart, 'a start for config-editor');
  assert.ok(readmeStart, 'a start for readme-section-writer');

  // Each start carries its correlation id and a short task label.
  assert.ok(configStart.toolUseId && configStart.toolUseId.startsWith('toolu_'));
  assert.ok(readmeStart.toolUseId && readmeStart.toolUseId.startsWith('toolu_'));
  assert.strictEqual(configStart.description, 'Add repository and files to package.json');
  assert.strictEqual(readmeStart.description, 'Update README Install section');

  // The single end correlates to config-editor's start; readme-section-writer
  // (in-flight) has NO end.
  assert.strictEqual(ends[0].toolUseId, configStart.toolUseId, 'end matches config-editor start');
  assert.ok(
    !ends.some((e) => e.toolUseId === readmeStart.toolUseId),
    'no end for the in-flight readme-section-writer dispatch'
  );
});

test('parseLog: dispatch detection ignores prose "dispatch" and non-dispatch tools', () => {
  // An assistant text block that says the word "dispatch", plus Bash and Read
  // tool_use blocks — none of which is a sub-agent dispatch.
  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'About to dispatch the test-writer to dispatch some work.' },
          { type: 'tool_use', id: 'toolu_bash01', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', id: 'toolu_read01', name: 'Read', input: { file_path: '/x.js' } },
        ],
      },
    }),
  ].join('\n');

  const p = parseLog(lines, 'fullstack-dev-2026-06-11T07-24-18.log');
  assert.ok(p);
  assert.ok(Array.isArray(p.dispatches));
  assert.strictEqual(p.dispatches.length, 0, 'prose + Bash/Read yield zero dispatch markers');
});

test('parseLog: malformed JSON line yields no dispatch markers and never throws', () => {
  const p = parseLog('{not valid json at all\n', 'foo-2026-01-01T00-00-00.log');
  assert.ok(p);
  assert.deepStrictEqual(p.dispatches, []);
});

test('parseLog: run_agent_in_docker variant maps agent_name to childAgent', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_mcp01',
          name: 'mcp__project-voltron__run_agent_in_docker',
          input: { agent_name: 'Route-Adder', task: 'add a route' },
        },
      ],
    },
  });
  const p = parseLog(line + '\n', 'devops-engineer-2026-06-11T07-24-18.log');
  assert.ok(p);
  assert.strictEqual(p.dispatches.length, 1);
  assert.strictEqual(p.dispatches[0].kind, 'dispatch:start');
  assert.strictEqual(p.dispatches[0].childAgent, 'route-adder', 'normalized lower-case');
  assert.strictEqual(p.dispatches[0].toolUseId, 'toolu_mcp01');
  assert.strictEqual(p.dispatches[0].description, 'add a route');
});

test('parseLog: existing return fields remain intact alongside dispatches', () => {
  const file = 'submanager-dispatch.log';
  const p = parseLog(readFixture(file), file);
  // The fixture opens with [entry]/[exec] lines — state still derives normally.
  assert.strictEqual(p.agent, 'submanager-dispatch');
  assert.strictEqual(p.state, 'working');
  assert.ok(Array.isArray(p.steps));
  assert.ok(Array.isArray(p.dispatches));
});
