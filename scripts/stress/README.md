# Voltron Glimpse — stress harness

Implements the tooling and SMOKE run from [`docs/stress-test-plan.md`](../../docs/stress-test-plan.md).
Lives **outside** the shipped package (not in `package.json` `files`), adds **no
runtime dependencies** (Node core + the already-present `ws` client only), and
**never writes** under a real `.voltron/`/`.beads/` — every synthetic write goes
into an `os.tmpdir()` throwaway root guarded by `assertTempRoot()`.

## Run

```bash
npm run stress:smoke          # full smoke set, prints a PASS/FAIL table
STRESS_V2_MS=4000 npm run stress:smoke   # shorter V2 churn window
```

Exit code is `0` only when every smoke vector passes.

## Layout

```
lib/
  tempProject.js   T3 — temp-root writer + the MANDATORY assertTempRoot() guard
  fakeDocker.js    T1 — fake `docker ps` exec + container factory; T2 — fake `docker logs` spawn stub
  fakeClock.js     T4 — deterministic fake clock (makeFakeClock), size() leak hook
  wsSwarm.js       T5 — `ws` client swarm (open / drain / pause-for-backpressure / close)
  server.js        in-process Glimpse backend (bus→state→reconciler→wsServer) on 127.0.0.1
  instrument.js    latency (perf_hooks p50/p95/p99), RSS sampler (1s), FD count (/proc/self/fd)
  util.js          sleep / until / result-record
vectors/
  v9.js  reconciler timer pressure (fake clock)   — every enter → exactly one exit, 0 orphan timers
  v8.js  daemon flap / kill / recovery            — 0 spurious churn on failed poll, resync ≤ 2 cadences
  v4.js  log rotation / truncation                — never a stuck-live node; documents offset-tail bounded loss
  v2.js  churn (~20 enter+exit/sec, 10 clients)   — broadcast latency p95 ≤ 300 ms, live set drains
  v6.js  WS backpressure (3 dead consumers)       — healthy clients keep receiving, RSS bounded
run-smoke.js       smoke entry point; demonstrates the tmpdir guard, runs V9→V8→V4→V2→V6
real-containers.sh T6 — host-only V11 real-daemon generator (RUN ON THE HOST, not in a container)
```

## Soak / host vectors (not in smoke)

`real-containers.sh` prepares the host-only V11 real-daemon smoke. It is **not**
run by `stress:smoke` (container agents cannot reach the host Docker daemon —
`docs/live-monitor-redesign.md` §7 B11); execute it on the host alongside a live
`voltron-glimpse`. The soak vectors (V1, V3, V5, V7, V10, full V2) are described
in the plan and reuse these same `lib/` tools at larger magnitudes.

## Known, documented findings from the smoke run

- **V4 / S3 offset asymmetry:** a post-rotation `[exit]` written to a fresh inode
  (rename+recreate) or after a truncate-in-place is **not** delivered via the
  offset tail when the tracked offset exceeds the new file size (`logs.js:118`
  `start >= size` early-return). The node is **never left stuck-live** because the
  Docker-drop membership poll winds it down — but the log `[exit]` line itself is a
  bounded loss. This matches the plan's flagged S3 failure mode.
- **V6 / S6 backpressure:** `safeSend` (`wsServer.js:6`) has no `bufferedAmount`
  guard. For the smoke volume (5000 small frames) the kernel socket buffers absorb
  the dead-consumer backlog and server RSS stays bounded; healthy clients are never
  starved. The unbounded-buffer risk is real but only surfaces at larger frame
  sizes / much higher volume (a soak-scale probe).
