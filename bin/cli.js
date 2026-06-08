#!/usr/bin/env node
'use strict';

const path = require('path');
const open = require('open');

const { resolveProjectRoot } = require('../src/projectRoot');
const { createEventBus, EVENTS } = require('../src/eventBus');
const { StateModel } = require('../src/state');
const { createHttpServer } = require('../src/transport/httpServer');
const { createWsServer } = require('../src/transport/wsServer');
const { createWatcher } = require('../src/watcher');

const DEFAULT_PORT = 7424;
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
      'voltron-glimpse — real-time, read-only Voltron run visualizer',
      '',
      'Usage: voltron-glimpse [options]',
      '',
      'Options:',
      '  --port <n>    Port to bind (default 7424; auto-increments if taken)',
      '  --no-open     Do not open the dashboard in a browser',
      '  --root <path> Project root (defaults to nearest ancestor with .voltron/)',
      '  --docker      Enable docker introspection (stub; reserved)',
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
    docker: false,
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const startDir = opts.root ? path.resolve(opts.root) : process.cwd();
  const projectRoot = resolveProjectRoot(startDir);
  if (!projectRoot) {
    fail('no .voltron/ found — run inside a Voltron project (or pass --root <path>)');
  }

  if (opts.verbose) {
    process.stdout.write(`project root: ${projectRoot}\n`);
    process.stdout.write(`public dir:   ${PUBLIC_DIR}\n`);
    if (opts.docker) {
      process.stdout.write('docker introspection: enabled (stub — no-op for now)\n');
    }
  }

  const bus = createEventBus();
  const state = new StateModel();
  // Keep the in-memory snapshot current: every domain event updates the model.
  for (const eventName of Object.values(EVENTS)) {
    bus.on(eventName, function (payload) {
      state.applyEvent(eventName, payload);
    });
  }

  const httpServer = createHttpServer(PUBLIC_DIR);
  const wsServer = createWsServer(httpServer, state, bus);

  let port;
  try {
    port = await listenWithFallback(httpServer, opts.port, HOST);
  } catch (err) {
    fail(`failed to bind HTTP server: ${err && err.message ? err.message : err}`);
  }

  const watcher = createWatcher(projectRoot, bus);
  // Populate the first snapshot from whatever already exists on disk.
  watcher.scanExisting();

  const url = `http://${HOST}:${port}`;
  process.stdout.write(`voltron-glimpse  →  ${url}\n`);
  process.stdout.write(`watching ${path.join(projectRoot, '.voltron')} (read-only)\n`);

  if (opts.open) {
    Promise.resolve(open(url)).catch(function () {
      process.stdout.write(`open the dashboard manually: ${url}\n`);
    });
  }

  let closing = false;
  function shutdown() {
    if (closing) return;
    closing = true;
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
