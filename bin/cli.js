#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const open = require('open');

const { resolveProjectRoot } = require('../src/projectRoot');
const { createEventBus, EVENTS } = require('../src/eventBus');
const { StateModel } = require('../src/state');
const { createHttpServer } = require('../src/transport/httpServer');
const { createWsServer } = require('../src/transport/wsServer');
const { createWatcher } = require('../src/watcher');
const { pollDocker } = require('../src/docker');
const { createDockerLogTailer } = require('../src/dockerLogs');
const { createReconciler, HUB_ID } = require('../src/liveness');
const { parseLog } = require('../src/parsers/logs');
const { normalizePodPath } = require('../src/pods');

const DEFAULT_PORT = 7424;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_HUB_FRESHNESS_MS = 60000;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_PORT_TRIES = 50;

function fail(msg) {
  process.stderr.write(`voltron-glimpse: ${msg}\n`);
  process.exit(1);
}

function printHelp() {
  process.stdout.write(
    [
      'voltron-glimpse — live, read-only Voltron running-agent monitor',
      '',
      'Usage: voltron-glimpse [options]',
      '',
      'Options:',
      '  --port <n>    Port to bind (default 7424; auto-increments if taken)',
      '  --no-open     Do not open the dashboard in a browser',
      '  --root <path> Project root (defaults to nearest ancestor with .voltron/)',
      '  --docker      Use Docker introspection for liveness (default: on)',
      '  --no-docker   Skip Docker; infer liveness from log freshness (degraded)',
      '  --poll <ms>   Docker/log poll cadence in ms (default 1000)',
      '  --all-pods    Show containers from every Voltron project (default: only this one)',
      '  --pod <v>     Scope to a specific pod by basename or path (repeatable)',
      '  --hub-freshness <ms>  Journal idle window for the scrum-master hub (default 60000)',
      '  --verbose     Verbose logging',
      '  -h, --help    Show this help',
      '',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    open: true,
    root: null,
    docker: true, // Docker is the default, primary liveness path now.
    poll: DEFAULT_POLL_MS,
    hubFreshness: DEFAULT_HUB_FRESHNESS_MS,
    allPods: false,
    pods: [],
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--port': {
        const v = argv[++i];
        const n = Number.parseInt(v, 10);
        if (!Number.isInteger(n) || n < 0 || n > 65535) {
          fail(`invalid --port value: ${v}`);
        }
        opts.port = n;
        break;
      }
      case '--no-open':
        opts.open = false;
        break;
      case '--root': {
        const v = argv[++i];
        if (!v) fail('--root requires a path argument');
        opts.root = v;
        break;
      }
      case '--docker':
        opts.docker = true;
        break;
      case '--no-docker':
        opts.docker = false;
        break;
      case '--poll': {
        const v = argv[++i];
        const n = Number.parseInt(v, 10);
        if (!Number.isInteger(n) || n < 1) {
          fail(`invalid --poll value: ${v}`);
        }
        opts.poll = n;
        break;
      }
      case '--all-pods':
        opts.allPods = true;
        break;
      case '--pod': {
        const v = argv[++i];
        if (!v) fail('--pod requires a label or path argument');
        opts.pods.push(v);
        break;
      }
      case '--hub-freshness': {
        const v = argv[++i];
        const n = Number.parseInt(v, 10);
        if (!Number.isInteger(n) || n < 1) {
          fail(`invalid --hub-freshness value: ${v}`);
        }
        opts.hubFreshness = n;
        break;
      }
      case '--verbose':
        opts.verbose = true;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${a}`);
    }
  }
  return opts;
}

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    function onError(err) {
      server.removeListener('listening', onListening);
      reject(err);
    }
    function onListening() {
      server.removeListener('error', onError);
      resolve();
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function listenWithFallback(server, startPort, host) {
  let port = startPort;
  for (let i = 0; i < MAX_PORT_TRIES; i++) {
    try {
      await listenOnce(server, port, host);
      return port;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        port += 1;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`no free port found in range ${startPort}-${startPort + MAX_PORT_TRIES}`);
}

// Degraded fallback (--no-docker): scan `.voltron/logs/*.log`, parse each, and
// build log-freshness entries (mtime-based) for the reconciler. See §2.5.
function scanLogsForFreshness(logsDir) {
  let entries;
  try {
    entries = fs.readdirSync(logsDir);
  } catch (_e) {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (path.extname(name).toLowerCase() !== '.log') continue;
    const file = path.join(logsDir, name);
    let content;
    let mtimeMs;
    try {
      content = fs.readFileSync(file, 'utf8');
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch (_e) {
      continue;
    }
    const parsed = parseLog(content, file);
    if (!parsed) continue;
    out.push({
      nodeId: parsed.nodeId,
      agent: parsed.agent,
      containerName: parsed.containerName,
      createdAt: null,
      state: parsed.state,
      exitCode: parsed.exitCode,
      hasExec: parsed.state === 'working',
      mtimeMs,
    });
  }
  return out;
}

// Is a pod's host log dir actually resolvable + readable? Returns the resolved
// `<podRoot>/.voltron/logs` path when readable, else null. Read-only stat/access.
function readableLogDir(podRoot) {
  if (!podRoot || typeof podRoot !== 'string') return null;
  const logsDir = path.join(podRoot, '.voltron', 'logs');
  try {
    const st = fs.statSync(logsDir);
    if (!st.isDirectory()) return null;
    fs.accessSync(logsDir, fs.constants.R_OK);
    return logsDir;
  } catch (_e) {
    return null;
  }
}

// Mutate each scoped container with `observed` (are its logs actually watched?)
// and collect the distinct FOREIGN pod roots whose log dirs are readable so the
// watcher can tail them. Self-pod containers are always observed (self log root is
// pinned). A foreign pod with an unreadable/unresolvable log dir is flagged
// observed:false — honest "logs unobserved" rather than a perpetual dispatch.
function planLogObservability(containers) {
  const roots = new Map(); // podRoot -> { root, podKey, podLabel }
  for (const c of Array.isArray(containers) ? containers : []) {
    if (!c) continue;
    if (c.selfPod === true) {
      c.observed = true;
      continue;
    }
    const logsDir = readableLogDir(c.podRoot);
    if (logsDir) {
      c.observed = true;
      if (!roots.has(c.podRoot)) {
        roots.set(c.podRoot, { root: c.podRoot, podKey: c.podKey, podLabel: c.podLabel });
      }
    } else {
      c.observed = false;
    }
  }
  return Array.from(roots.values());
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const startDir = opts.root ? path.resolve(opts.root) : process.cwd();
  const projectRoot = resolveProjectRoot(startDir);
  if (!projectRoot) {
    fail('no .voltron/ found — run inside a Voltron project (or pass --root <path>)');
  }

  const logsDir = path.join(projectRoot, '.voltron', 'logs');

  // Pod scoping: the CLI's own pod is its resolved project root. By default the
  // live set is filtered to this pod; --all-pods / --pod widen it (design §3).
  const selfPodKey = normalizePodPath(projectRoot);
  const podCache = new Map();
  const podScope = { allPods: opts.allPods, pods: opts.pods };

  if (opts.verbose) {
    process.stdout.write(`project root: ${projectRoot}\n`);
    process.stdout.write(`public dir:   ${PUBLIC_DIR}\n`);
    process.stdout.write(
      `liveness:     ${opts.docker ? 'docker' : 'log-freshness (degraded)'} (poll ${opts.poll}ms)\n`
    );
    const scopeDesc = opts.allPods
      ? 'all pods'
      : opts.pods.length
      ? `pods: ${opts.pods.join(', ')}`
      : `self pod (${selfPodKey})`;
    process.stdout.write(`pod scope:    ${scopeDesc}\n`);
  }

  const bus = createEventBus();
  const state = new StateModel();
  // Keep the in-memory snapshot current: every domain event updates the model.
  for (const eventName of Object.values(EVENTS)) {
    bus.on(eventName, function (payload) {
      state.applyEvent(eventName, payload);
    });
  }

  const reconciler = createReconciler({ bus, hubFreshnessMs: opts.hubFreshness });

  const httpServer = createHttpServer(PUBLIC_DIR);
  const wsServer = createWsServer(httpServer, state, bus);

  let port;
  try {
    port = await listenWithFallback(httpServer, opts.port, HOST);
  } catch (err) {
    fail(`failed to bind HTTP server: ${err && err.message ? err.message : err}`);
  }

  // Logs + journal watcher (both modes): logs enrich live nodes with
  // [exec]/[STEP]/[exit]; the journal drives scrum-master hub liveness. The
  // watcher globs `.voltron/journal/*.md`, so a UTC-midnight day-file rollover is
  // picked up automatically (a new day's first append is handled like any other).
  const watcher = createWatcher(
    projectRoot,
    function (parsed) {
      reconciler.applyLogEvent(parsed);
    },
    function (signal) {
      reconciler.applyJournalEvent(signal);
    }
  );
  watcher.scanExisting();

  let pollTimer = null;
  let lastAvailable = null;
  let logTailer = null;

  if (opts.docker) {
    // Per-container `docker logs` tailing — the FAST activity signal. A container
    // can stream to `docker logs` (visibly thinking) before its first
    // `.voltron/logs` [exec]/[STEP] line lands; this advances the node
    // dispatching→working from the first byte it emits. Read-only; created only in
    // Docker mode so the --no-docker path never spawns.
    logTailer = createDockerLogTailer({
      onActivity: function (nodeId) {
        reconciler.applyDockerLogActivity(nodeId);
      },
    });
    // Authoritative membership from `docker ps`.
    const pollOnce = async function () {
      const result = await pollDocker({ cwd: projectRoot, podCache, selfPodKey, scope: podScope });
      // Multi-root log watching: flag each container's observability and watch every
      // in-scope FOREIGN pod's log dir (self is pinned). Done BEFORE applyDockerPoll
      // so entries carry `observed`, and BEFORE pollTail so a freshly-appeared pod's
      // logs are tailed this same tick (advancing it past `dispatching`).
      const foreignRoots = planLogObservability(result.containers);
      watcher.syncLogRoots(foreignRoots);
      reconciler.applyDockerPoll(result);
      // Start/stop per-container docker-logs tails to match the live set. Synced
      // only when the daemon actually answered (available:true) so a transient
      // daemon blip never tears down healthy tails or spawns against a dead socket.
      if (result.available) logTailer.sync(result.containers);
      // Poll-driven log re-tail on the same cadence: advance [exec]/[STEP]/[exit]
      // enrichment without depending on chokidar native fs-watch events firing
      // (unreliable for container-written logs on WSL2/Windows bind mounts). The
      // offset-tracked tail is idempotent, so this is safe alongside the watcher.
      watcher.pollTail();
      // Propagate Docker availability to the WS snapshot even when membership
      // is unchanged (e.g. daemon up but no containers running).
      if (result.available !== lastAvailable) {
        lastAvailable = result.available;
        const snap = reconciler.snapshot();
        bus.emit(EVENTS.EDGE_UPDATE, {
          hub: snap.hub ? HUB_ID : null,
          edges: snap.edges,
          dockerAvailable: snap.dockerAvailable,
        });
      }
    };
    pollOnce();
    pollTimer = setInterval(pollOnce, opts.poll);
  } else {
    // Degraded: infer membership from log freshness on the same cadence. Also
    // re-tail the journal so the scrum-master hub stays live without Docker (the
    // idle-tick that flips the hub to idle is armed inside the reconciler).
    const freshOnce = function () {
      reconciler.applyLogFreshness(scanLogsForFreshness(logsDir));
      watcher.pollTail();
    };
    freshOnce();
    pollTimer = setInterval(freshOnce, opts.poll);
  }
  if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();

  const url = `http://${HOST}:${port}`;
  process.stdout.write(`voltron-glimpse  →  ${url}\n`);
  process.stdout.write(`watching ${logsDir} (read-only)\n`);

  if (opts.open) {
    Promise.resolve(open(url)).catch(function () {
      process.stdout.write(`open the dashboard manually: ${url}\n`);
    });
  }

  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
    if (pollTimer) clearInterval(pollTimer);
    if (logTailer) logTailer.close();
    process.stdout.write('\nvoltron-glimpse: shutting down…\n');
    Promise.resolve()
      .then(function () {
        return watcher.close();
      })
      .catch(function () {})
      .then(function () {
        return new Promise(function (resolve) {
          wsServer.close(function () {
            resolve();
          });
        });
      })
      .catch(function () {})
      .then(function () {
        return new Promise(function (resolve) {
          httpServer.close(function () {
            resolve();
          });
        });
      })
      .catch(function () {})
      .then(function () {
        process.exit(0);
      });
    // Safety: force-exit if graceful close stalls.
    setTimeout(function () {
      process.exit(0);
    }, 2000).unref();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(function (err) {
  fail(err && err.stack ? err.stack : String(err));
});
