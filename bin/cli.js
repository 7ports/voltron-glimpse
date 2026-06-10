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
const { createReconciler, HUB_ID } = require('../src/liveness');
const { parseLog } = require('../src/parsers/logs');

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

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const startDir = opts.root ? path.resolve(opts.root) : process.cwd();
  const projectRoot = resolveProjectRoot(startDir);
  if (!projectRoot) {
    fail('no .voltron/ found — run inside a Voltron project (or pass --root <path>)');
  }

  const logsDir = path.join(projectRoot, '.voltron', 'logs');

  if (opts.verbose) {
    process.stdout.write(`project root: ${projectRoot}\n`);
    process.stdout.write(`public dir:   ${PUBLIC_DIR}\n`);
    process.stdout.write(
      `liveness:     ${opts.docker ? 'docker' : 'log-freshness (degraded)'} (poll ${opts.poll}ms)\n`
    );
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

  if (opts.docker) {
    // Authoritative membership from `docker ps`.
    const pollOnce = async function () {
      const result = await pollDocker({ cwd: projectRoot });
      reconciler.applyDockerPoll(result);
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
