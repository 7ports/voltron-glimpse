const { execFile } = require('node:child_process');
const { deriveAgentName } = require('./parsers/logs');

const VOLTRON_PREFIX = 'voltron-';

// Read-only: lists running Voltron containers. Never run/stop/rm/exec/create.
const DOCKER_PS_ARGS = [
  'ps',
  '--no-trunc',
  '--filter',
  'name=voltron-',
  '--format',
  '{{.ID}}\t{{.Names}}\t{{.CreatedAt}}\t{{.State}}\t{{.Status}}',
];

// nodeId = container name with the leading `voltron-` stripped (== the log stem).
function deriveNodeId(name) {
  if (typeof name !== 'string') return '';
  return name.startsWith(VOLTRON_PREFIX) ? name.slice(VOLTRON_PREFIX.length) : name;
}

// Parse tab-separated `docker ps --format` output (no header line).
// Tolerates blank lines and CRLF. Keeps only `voltron-` containers.
function parseDockerPs(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 2) continue;
    const id = (cols[0] || '').trim();
    const name = (cols[1] || '').trim();
    if (!name.startsWith(VOLTRON_PREFIX)) continue;
    const nodeId = deriveNodeId(name);
    rows.push({
      id,
      name,
      nodeId,
      agent: deriveAgentName(nodeId),
      createdAt: (cols[2] || '').trim(),
      state: (cols[3] || '').trim(),
      status: (cols[4] || '').trim(),
    });
  }
  return rows;
}

// Default exec: shell out to the host `docker` CLI (read-only `docker ps`).
function defaultExec(cwd) {
  return new Promise((resolve, reject) => {
    execFile('docker', DOCKER_PS_ARGS, { cwd, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout || '');
    });
  });
}

// Poll the daemon. exec is injectable for tests (default: defaultExec).
// On ANY failure (docker missing, daemon down, non-zero exit) returns
// { available:false, containers:[] } and never throws.
async function pollDocker({ cwd, exec } = {}) {
  const run = typeof exec === 'function' ? exec : () => defaultExec(cwd);
  try {
    const stdout = await run({ cwd });
    return { available: true, containers: parseDockerPs(typeof stdout === 'string' ? stdout : '') };
  } catch {
    return { available: false, containers: [] };
  }
}

module.exports = { parseDockerPs, pollDocker, deriveNodeId, DOCKER_PS_ARGS };
