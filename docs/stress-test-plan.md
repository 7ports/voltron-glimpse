# Voltron Glimpse — Stress-Test Methodology

> **Status:** design only (DESIGN-ONLY task, bead `glimpse-lq7`). This document
> defines *how* to stress Voltron Glimpse and *what bars it must clear*. It
> implements no harness, test, or code, and changes nothing under `src/`,
> `public/`, or `test/`. Grounded by reading the actual sources listed in
> §Load-bearing surfaces against `docs/implementation-plan.md` and
> `docs/live-monitor-redesign.md`.
>
> **One-line intent:** prove that the read-only live monitor stays *present-tense,
> bounded, and honest* under high container count, high churn, high log
> throughput, many WS clients, and a flapping Docker daemon — without ever
> writing a byte under a real `.voltron/`/`.beads/`, and without binding off
> `127.0.0.1`.

---

## Read-only & safety discipline (read this before building anything)

The harness manipulates the *same inputs the app reads*. A careless generator
can violate the product's core invariant. Non-negotiable rules for every vector
below:

1. **Never generate load into a real `.voltron/` or `.beads/`.** All synthetic
   logs and journals are written into a **throwaway temp project root** created
   with `fs.mkdtempSync(path.join(os.tmpdir(), 'glimpse-stress-'))`, laid out as
   `<tmp>/.voltron/logs/` and `<tmp>/.voltron/journal/`. Glimpse is pointed at it
   with `--root <tmp>`. The harness writes only inside that temp tree and deletes
   it on teardown. The app itself is already read-only; the *generator* is the
   only writer, and it must never target a path the developer cares about.
2. **Prefer fakes over real containers.** The codebase exposes injection seams
   precisely so liveness can be driven without a daemon:
   - `pollDocker({ exec, inspectExec })` — `exec` returns the raw `docker ps`
     text; `inspectExec` returns `docker inspect` JSON (`src/docker.js:62`).
   - `createDockerLogTailer({ spawn })` — fake child processes with mock
     `stdout`/`stderr` streams (`src/dockerLogs.js:28`).
   - `createReconciler({ timer })` — injectable fake clock for deterministic
     linger/freshness (`src/liveness.js:60`; pattern already used in
     `test/liveness.test.js`).
   Synthetic-membership load (container count, churn, daemon flap, reconciler
   timer pressure) needs **no Docker** — it is driven by feeding fabricated
   `docker ps` text and scripted log events through these seams.
3. **Real containers only for the host-only end-to-end smoke (vector V9).** Per
   `docs/live-monitor-redesign.md` §7 B11, the true daemon path can only run on
   the host. When used, the harness must `docker run` **throwaway** containers
   named `voltron-stress-<agent>-<ISO>-<suffix>` (so the `name=voltron-` filter
   matches) running a trivial `sleep`/echo loop, and must `docker rm -f` them on
   teardown. It must **never** `stop`/`rm`/`exec` a container it did not create —
   honor the "we never `docker run/stop/exec` the app's containers" rule.
4. **No new runtime dependencies, no build step.** Generators use only Node core
   (`fs`, `os`, `path`, `child_process`, `perf_hooks`, `worker_threads`) and the
   already-present `ws` package (which ships a `WebSocket` *client* usable to
   simulate browsers). The frontend stays vendored/vanilla. The harness lives
   *outside* the shipped package (e.g. a `scripts/stress/` or ad-hoc dir that is
   never added to `package.json` `files`).
5. **Bind discipline holds under load.** Every WS client the harness opens must
   target `ws://127.0.0.1:<port>` — confirming, not bypassing, the localhost-only
   bind (`bin/cli.js` `HOST = '127.0.0.1'`).

---

## Load-bearing surfaces

Each surface below can buckle under load; the specific failure mode is what the
matching stress vector targets.

| # | Surface | File | Failure mode under load |
|---|---|---|---|
| S1 | **Docker poller** | `src/docker.js` | `execFile` runs with `maxBuffer: 1024*1024` (1 MB). A very large `docker ps` (thousands of rows) overflows → `ENOBUFS` → `catch` returns `{available:false}`. The reconciler treats `available:false` as **"no change"** (`liveness.js:217`), so the **entire live set freezes** instead of updating. Also: each poll spawns one child process; `resolvePods` issues a `docker inspect` per *uncached* container → an **N-wide `docker inspect` storm** the first time N new containers appear. |
| S2 | **Per-container log tailers** | `src/dockerLogs.js` | One `spawn('docker logs -f')` per live container. A container that emits **no bytes** keeps its follow process alive until it leaves the set — so a large set of slow-start containers accumulates **N live child processes + 2N pipe FDs**. File-handle / PID exhaustion; orphaned children if `close()` misses. |
| S3 | **Log watcher** | `src/watcher.js` | `chokidar` runs `usePolling:true, interval:500` per log root, **plus** `pollTail()` on every poll cadence walks every `*.log` in every root. Many pods → many polling watchers each `readdir`+`stat`-ing every 500 ms. Many/large log files → per-cadence `readdir` + offset reads. **Log rotation/truncation** (file replaced or shrunk) defeats offset tracking: `start >= size` returns early (`logs.js:118`), so post-rotation content can be **missed** or, on truncate-in-place, mis-read. |
| S4 | **Reconciler** | `src/liveness.js` | Per-entry `exitTimer` (`setTimeout`, linger 2.5 s / errored 4 s). High churn → many pending timers + many `recomputeEdges()` calls (each rebuilds the **full** edge array and emits `EDGE_UPDATE`). `pendingDispatches` is `filter`-pruned every poll (O(pending)). A membership flap faster than the linger window can leave a node perpetually winding down. `hubIdleTimer` re-armed on every journal append. |
| S5 | **State model** | `src/state.js` | `snapshot()` deep-clones the whole live set via `JSON.parse(JSON.stringify(...))` **on every WS connect** (`state.js:16`). `EDGE_UPDATE` replaces the entire `edges` array. Large live set × reconnect storm → repeated full deep-clones. |
| S6 | **WS server** | `src/transport/wsServer.js` | For each bus event it builds one `message`, then **`safeSend` calls `JSON.stringify(payload)` again per client** (`wsServer.js:6`) → `C × E` serializations for C clients and E events/sec. `client.send()` is called with **no backpressure check** — a slow client's `bufferedAmount` grows unbounded → **RSS balloon**. No per-message serialization cache. |
| S7 | **HTTP static server** | `src/transport/httpServer.js` | Streams files per request; a connection/refresh storm opens many concurrent `fs.createReadStream`s. Lower risk (static, small assets) but part of the reconnect-storm surface. |
| S8 | **Frontend live core** | `public/app.js` | The single rAF `pulseFrame` loop writes Cytoscape styles for **every `.working` node every frame** (`app.js:765`); layout is debounced 200 ms / animated 400 ms (`app.js:55`). Node count beyond a threshold → dropped frames; churn faster than the debounce → layout thrash. (Browser-side; load it via the host harness but measure in-page.) |
| S9 | **Snapshot path on connect** | `wsServer.js` + `state.js` | Every new WS connection triggers a full `snapshot()` serialize+send. A backoff-driven reconnect storm (clients all reconnecting) multiplies snapshot cost. |

---

## Stress vectors + magnitudes

Concrete, quantified scenarios. Numbers are the **target operating points** the
methodology drives to; the bars they must clear are in §Pass/fail thresholds.
Each vector names which surfaces it loads and whether it is driven by **fakes**
(no daemon) or needs **real containers**.

### V1 — Container count (scale of the live set)
- **Drive:** feed fabricated `docker ps` text via `pollDocker({ exec })` with a
  steady **1 → 50 → 200 → 500 → 1000** running `voltron-*` rows; hold each level
  ≥ 60 s. Each level also exercises the first-sighting `docker inspect` storm via
  a fake `inspectExec`.
- **Loads:** S1, S4 (edge rebuild O(N)), S5, S6 (snapshot size), S8.
- **Why these magnitudes:** real Voltron sprints run tens of concurrent
  containers; 500–1000 is a deliberate 10–20× headroom probe to find the
  `maxBuffer`/`O(N)`-edge knees.

### V2 — Container churn (enter/exit rate)
- **Drive:** with the fake poller, oscillate membership so containers enter and
  exit at **1, 5, 20, 50 enter+exit events/sec**, sustained 5 min each. Mix
  Docker-drop exits (absence in next poll) with fast-path `[exit] code=N` log
  exits to exercise both paths in `liveness.js` (`applyDockerPoll` +
  `applyLogEvent`).
- **Loads:** S4 (timer churn + `recomputeEdges` frequency), S6 (delta volume),
  S8 (layout thrash). Interacts with the **present-tense / linger** design — see
  §Design-interaction flags.
- **Magnitude rationale:** 50/sec is far above any real sprint; it surfaces
  whether per-event edge rebuilds + timers stay bounded.

### V3 — Log throughput (per-container and aggregate)
- **Drive:** write synthetic `.voltron/logs/*.log` files in the **temp root**,
  appending `[STEP N]` lines at **10, 100, 1000 lines/sec per container** across
  **10 → 100** live log files, up to an aggregate of **~10 MB/sec** total. Mix in
  `committer`-style logs that emit only `[entry]/[exec]/[exit]` (no steps) to
  exercise the no-step path.
- **Loads:** S3 (offset-tail read volume, `pollTail` cost), S4 (`applyLogEvent`
  + `recentSteps` churn), S6 (`AGENT_UPDATE` broadcast volume).
- **Note:** `recentSteps` is capped at 5 (`liveness.js:7`) and labels truncate —
  verify those caps actually bound memory under 1000 lines/sec.

### V4 — Log rotation / truncation
- **Drive:** during V3, rotate a hot log: (a) rename `x.log`→`x.1.log` and create
  a fresh `x.log`; (b) truncate `x.log` in place to 0 then append. Do each ~10×.
- **Loads:** S3 offset logic specifically.
- **Magnitude:** low count, high importance — this is a correctness probe, not a
  throughput probe.

### V5 — WS client fan-out
- **Drive:** open **1, 10, 50, 200** concurrent `ws` clients (Node `WebSocket`
  from the bundled `ws`) against `ws://127.0.0.1:<port>`, each consuming the feed,
  while V2 churn runs at 20 events/sec.
- **Loads:** S6 (`C × E` serialization), S5 (snapshot per connect), S9.
- **Magnitude rationale:** the product is localhost single-user, but tabs +
  reconnects realistically reach ~10; 200 is the headroom probe that exposes the
  per-client `JSON.stringify` and missing-backpressure costs.

### V6 — WS slow-consumer / backpressure
- **Drive:** open 10 clients, of which 3 **never read** their socket (pause the
  receive side) while V3 pushes ~5000 `AGENT_UPDATE`/sec into the bus.
- **Loads:** S6 backpressure path specifically (`client.send` with no
  `bufferedAmount` guard).
- **Goal:** determine whether server RSS grows unbounded buffering for dead
  consumers, and whether healthy clients still receive frames.

### V7 — Reconnect storm
- **Drive:** 50 clients connect, then all disconnect and reconnect every 2 s for
  3 min (simulating the frontend's backoff loop after a server blip), each
  triggering a full `snapshot()` of a 200-node live set.
- **Loads:** S5, S7, S9.

### V8 — Docker daemon flap / kill / recovery
- **Drive (fakes):** script `exec` to alternate **success → throw (daemon down)
  → success** at **0.2, 1, 5 Hz** flap rates, and a one-shot 60 s outage then
  recovery. Verify the "single failed poll = no change" rule (`liveness.js:218`)
  holds and that recovery re-syncs membership without tearing down/duplicating
  nodes.
- **Loads:** S1, S4 (no spurious exits/enters), the `--no-docker` log-freshness
  fallback (`cli.js` `scanLogsForFreshness`).
- **Magnitude rationale:** daemon restarts (common on WSL2/Windows after reboot,
  per CLAUDE.md) are the real-world trigger; 5 Hz is an abusive flap probe.

### V9 — Reconciler timer pressure under churn (fake clock, deterministic)
- **Drive:** with the injectable `timer`, advance through V2-style churn so that
  at peak there are **hundreds of overlapping linger timers** (enter→exit faster
  than 2.5 s linger). Assert no timer leak and that every entered node eventually
  emits exactly one `AGENT_EXIT`.
- **Loads:** S4 timer/edge accounting in isolation (host-independent, runs in
  CI/container).

### V10 — Multi-pod watcher fan-out
- **Drive:** fabricate containers across **1, 5, 20** distinct pods (via
  `inspectExec` mount-source variety), each with its own temp `.voltron/logs/`
  dir, so `watcher.syncLogRoots` spins up that many polling chokidar watchers.
- **Loads:** S3 (watcher count, `pollTail` across roots), frontend compound-parent
  rebuild (`app.js` `retrofitCompoundParents`).

### V11 — Host-only real-daemon smoke (escalated)
- **Drive:** on the **host**, `docker run` 10–30 throwaway `voltron-stress-*`
  sleeper containers, let Glimpse discover them, then `docker rm -f` them in
  waves. This is the only vector that proves the real `docker ps`/`docker logs`
  path end-to-end.
- **Loads:** S1, S2, S3 against a live daemon.
- **Ownership:** prepared here, **executed on the host by the user/scrum-master**
  (container-run agents cannot query the host daemon — `live-monitor-redesign.md`
  §7 B11).

---

## Tooling

How to generate each load using **only** host-side Node core + the existing `ws`
dependency, no build step, writing only into a throwaway temp root. Each tool is
described as methodology (the harness is *not* implemented by this task).

### T1 — Fake Docker poller (drives V1, V2, V8, V10)
Build a generator function that returns `docker ps`-formatted text and pass it as
`pollDocker`'s `exec`. No daemon, no real containers.

```js
// METHODOLOGY SKETCH — not committed to src/. Lives in an external scripts dir.
function fakePsExec(rowsProvider) {
  return async () => rowsProvider()            // returns tab-separated lines:
    .map(c => [c.id, c.name, c.createdAt, 'running', 'Up 1 second'].join('\t'))
    .join('\n');
}
// Membership = rowsProvider(); flip it over time for churn (V2) or count (V1).
// For the daemon-flap (V8), have exec throw on the "down" ticks.
// For pods (V10), pair with a fakeInspectExec returning varied Mounts[].Source.
```
Container count, churn rate, flap rate, and pod spread are all just functions of
what `rowsProvider()` returns per tick — no privileged access required.

### T2 — Fake `docker logs` tailer spawn (drives V2 fast-path, S2)
Provide `createDockerLogTailer`'s `spawn` with a stub returning an object whose
`stdout` is an `EventEmitter`; emit a byte to simulate "first activity," or stay
silent to simulate a slow-start container that holds a follow process open
(probes S2 process accumulation). Track how many stubs are never `kill()`ed.

### T3 — Synthetic log/journal writer (drives V3, V4) — **temp root only**
A writer that appends to `<tmp>/.voltron/logs/<agent>-<ISO>-<suffix>.log` at a
controlled lines/sec, and to `<tmp>/.voltron/journal/<today>.md`. Run multiple
writers in `worker_threads` to hit aggregate MB/sec. Rotation (V4) = rename +
recreate, or `fs.truncate`. **Hard rule:** the target dir is the `mkdtemp` root
passed to Glimpse via `--root`; assert at startup that the path is under
`os.tmpdir()` and refuse to run otherwise — a guard against ever pointing at a
real project.

### T4 — Fake clock (drives V9, and deterministic linger checks everywhere)
Reuse the exact `makeFakeTimer()` pattern already in `test/liveness.test.js`
(records due times, fires on `advance(ms)`), injected via
`createReconciler({ timer })`. Lets timer-pressure and linger be exercised with
zero wall-clock and no flakiness — runs in CI/container.

### T5 — WS client swarm (drives V5, V6, V7)
Use the `WebSocket` *client* from the already-installed `ws` package to open N
connections to `ws://127.0.0.1:<port>`. For fan-out (V5) drain every socket; for
backpressure (V6) attach a no-op `'message'` handler on some clients but pause
the underlying socket (`client._socket.pause()`) so the server's `bufferedAmount`
for them climbs; for reconnect storm (V7) loop connect/close on a timer. Measure
server-side `wss.clients` `bufferedAmount` and client receive lag.

### T6 — Real-container generator (drives V11, host-only)
A shell/Node script that `docker run -d --name voltron-stress-<agent>-<ISO>-<sfx>
alpine sh -c 'while true; do echo step; sleep 1; done'` in waves, then
`docker rm -f` by the `voltron-stress-` name prefix. Only creates/removes its own
prefixed containers; never touches others. Host-executed and escalated.

### Measurement instrumentation (all vectors)
- **Latency:** stamp an event into the source (a `[STEP]` write, or a fake-poll
  membership change) and timestamp its arrival at a WS client; report
  p50/p95/p99 with `perf_hooks.performance.now()`.
- **Memory / handles:** sample `process.memoryUsage().rss` and (Linux)
  `fs.readdirSync('/proc/self/fd').length` for the Glimpse process every 1 s;
  also count child PIDs (`pgrep -P <pid>` on host, or track stub spawns under
  fakes) for S2.
- **Timers/listeners:** in fake-clock runs, assert the reconciler's internal
  timer set returns to baseline after churn drains; check
  `bus.listenerCount(...)` and `wss.clients.size` return to baseline after V7.
- **WS frames:** count emitted bus events vs frames received per client to detect
  drops; read `client.bufferedAmount` for backpressure.
- **Frontend (V8/S8):** load the real page against the live server, run the
  browser's `performance` + a rAF frame-time sampler in the page console;
  no automated browser needed — eyeball + frame-time log over a 60 s churn.

---

## Pass/fail thresholds

Explicit, measurable bars per vector. "Measured by" states the instrument.

| Vector | Metric | Pass bar | Measured by |
|---|---|---|---|
| **V1** (count) | Event→render latency at 200 nodes | **p95 ≤ 250 ms**, p99 ≤ 500 ms | source-stamp → WS-client arrival (T-latency) |
| **V1** | `docker ps` output handling at ≥ 1000 rows | **No `available:false` caused by `maxBuffer`** (set must still update); if the 1 MB cap is the limit, it is **documented with the row count at which it trips** | feed oversized fake `exec` output; assert `applyDockerPoll` saw `available:true` |
| **V1** | RSS at 1000 nodes vs 1 node | **Δ ≤ 150 MB**, no monotonic climb while count held steady | 1 s RSS sampler over a 60 s hold |
| **V2** (churn) | Steady-state RSS at 50 enter/exit-per-sec for 5 min | **Bounded** — RSS returns within **10 %** of pre-churn baseline within 30 s of churn stopping | RSS sampler before/during/after |
| **V2** | Reconciler timers after churn drains | **Returns to 0 lingering timers** (no leak) | fake-clock timer-set assertion (V9) |
| **V2** | Per-event broadcast latency | **p95 ≤ 300 ms** at 20 events/sec, 10 clients | T-latency |
| **V3** (throughput) | RSS at 1000 lines/sec/container × 100 files | **Bounded** (recentSteps cap of 5 holds); Δ ≤ 200 MB, no climb | RSS sampler + heap snapshot diff |
| **V3** | Dropped log events | **Zero** appended `[STEP]`/`[exit]` lines missed (offset tail is lossless) | count lines written vs `AGENT_UPDATE`/exit observed |
| **V4** (rotation) | Post-rotation content | **No missed `[exit]`** after a rotate; at worst a documented, bounded loss of pre-rotation tail — **never a stuck-live node** | write known marker post-rotation, assert it surfaces or the node exits |
| **V5** (fan-out) | CPU + latency at 200 clients during churn | **p95 latency ≤ 500 ms**; server stays responsive (new connect still gets snapshot < 1 s) | T-latency + connect-time probe |
| **V6** (backpressure) | Server RSS with 3 dead consumers @ 5000 ev/s | **Bounded growth** — either per-client buffer capped/closed, OR growth documented with the rate; **healthy clients keep receiving** (no starvation) | RSS sampler + healthy-client frame count + dead-client `bufferedAmount` |
| **V7** (reconnect storm) | Handles + listeners after storm | **FD count and `wss.clients.size` return to baseline** (no leak); no unclosed read streams | `/proc/self/fd` count + `wss.clients.size` post-storm |
| **V7** | Snapshot serialize time, 200-node set | **≤ 50 ms per snapshot**; storm causes no unbounded queue | `perf_hooks` around `snapshot()` (instrument externally) |
| **V8** (daemon flap) | False exits/enters during flap | **Zero** spurious `AGENT_EXIT`/`AGENT_ENTER` from a single failed poll; set unchanged across "down" ticks | event log diff across flap |
| **V8** | Recovery time after 60 s outage | Membership re-synced **within 2 poll cadences (≤ ~2 s at default 1000 ms)** of daemon return; no duplicate nodes | event log timestamps |
| **V8** | `--no-docker` fallback | Log-fresh nodes appear within **freshnessMs (15 s)** and wind down when mtime goes stale; **no crash** when `docker` absent | fallback run against temp logs |
| **V9** (timer pressure) | Timer/exit accounting | **Every entered node emits exactly one `AGENT_EXIT`**; zero orphaned timers; deterministic | fake-clock assertions |
| **V10** (multi-pod) | Watcher count + CPU at 20 pods | **One watcher per in-scope root, removed when pod leaves**; no watcher leak; CPU steady | `logRoots` size assertion + CPU sample |
| **V11** (host smoke) | Real enter→pulse→exit | Node appears **≤ 1 poll (~1 s)** after `docker run`, pulses on `[exec]`, leaves **≤ 1 s** after `docker rm`; **read-only audit passes** (`grep` shows no `fs.write*`/`appendFile` under `.voltron`/`.beads`) | host observation + grep audit |
| **All** | Bind discipline | **No listener on any non-`127.0.0.1` address** for HTTP or WS at any load | `ss -tlnp` / `netstat` during a run |
| **All** | Read-only invariant | **Zero writes** under any real `.voltron/`/`.beads/`; temp root is the only mutated tree | `strace -e trace=write` filter / fs-audit + post-run diff of the real repo |

Any vector that cannot meet its bar must be **documented with the breaking point**
(the count/rate/client number at which it degrades) rather than silently passed —
a known, stated ceiling is acceptable; an unmeasured one is not.

---

## Prioritized run order

Highest-risk-first, so the cheapest tests that protect the core invariants run
before the expensive host-only one.

1. **V9 — reconciler timer pressure (fake clock).** *Smoke.* Pure, deterministic,
   runs in CI/container in milliseconds. Highest leverage: timer/exit leaks here
   corrupt every other measurement. Run first, every time.
2. **V8 — daemon flap.** *Smoke.* Cheap (fake `exec`), and protects the most
   load-bearing real-world behavior (the "single failed poll = no change" rule).
   A regression here causes spurious node churn for every user on WSL2/Windows.
3. **V2 — churn** + **V4 — rotation.** *Smoke→soak.* Exercise the reconciler +
   offset-tail correctness that the live feel depends on. V4 is a fast
   correctness probe; V2 escalates into a 5-min soak.
4. **V6 — backpressure** then **V5 — fan-out.** *Smoke→soak.* The WS server's
   per-client `JSON.stringify` and missing backpressure guard are the most likely
   *unbounded-memory* defects; surface them before scaling client count.
5. **V1 — container count** and **V3 — log throughput.** *Soak.* The O(N) edge
   rebuild and `maxBuffer` knee live here; run as sustained holds to catch slow
   climbs.
6. **V7 — reconnect storm** and **V10 — multi-pod fan-out.** *Soak.* Leak
   detectors — value comes from running long enough to see FD/watcher counts fail
   to return to baseline.
7. **V11 — host-only real-daemon smoke.** *Gating, last.* Run on the host after
   all fake-driven vectors pass; it is the acceptance gate but the slowest and
   least repeatable, and must be **escalated to the user/scrum-master** to
   execute (container agents cannot reach the host daemon).

**Smoke set** (fast, gating every change): V9, V8, V4, a short V2, a short V6.
**Soak set** (periodic / pre-release): V1, V3, V5, V7, V10, and the full V2.
**Host gate** (release): V11.

---

## Design-interaction flags

Explicit risks where the present-tense / EOF-seeding design meets high churn or
where a harness could violate read-only discipline.

- **EOF-seeding vs. burst-at-startup (S3 / V3).** `watcher.scanExisting()` seeds
  the **self/pinned** log root + journal offsets to EOF (`watcher.js:211`,
  present-tense rule §2.5) — so a stress writer that pre-fills a log *before*
  Glimpse starts will have that history **intentionally ignored**; only
  post-start appends count. The harness must therefore **start Glimpse first,
  then begin writing**, or it will under-count events and wrongly report drops.
  Conversely, **foreign** pod roots are *not* seeded (read from offset 0), so a
  multi-pod (V10) writer that pre-fills a foreign log *will* have it fully
  replayed — the harness must account for this asymmetry when counting expected
  events.
- **Churn faster than linger (V2 / S4).** Linger is 2.5 s (4 s errored). At
  ≥ 50 enter/exit per sec, many nodes are simultaneously in `exiting:*` linger.
  This is *expected* (the present-tense view deliberately holds a finished node
  briefly), but it means the on-screen/live-set count **lags real membership by
  up to the linger window** — thresholds measure the *backend* live set and timer
  drainage, not the lingering visual count, to avoid mis-flagging the linger as a
  leak.
- **`available:false` freeze is a feature, not a hang (V1 / V8).** When a fake
  `exec` overflows `maxBuffer` or throws, the set **freezes** rather than
  emptying. A naive harness could misread a frozen set as "responsive." Tests
  must assert on the *availability flag and event stream*, not just node count.
- **Fast-path exit + Docker-drop double signal (V2).** A node can receive both a
  log `[exit]` and a subsequent Docker drop. `handleExit` is idempotent
  (`liveness.js:185` guards on `exitScheduled`), so the harness must expect
  **exactly one** `AGENT_EXIT` and treat a second as a regression.
- **Generator-as-writer is the only read-only risk.** The app never writes; the
  *harness* does. The single most dangerous mistake is pointing T3's writer at a
  real `.voltron/`. Mitigations are mandatory: `mkdtemp` under `os.tmpdir()`,
  a startup assertion that the write root is under tmp, `--root <tmp>` for
  Glimpse, and a post-run `git status`/diff of the real repo to prove nothing
  outside tmp changed.
- **Real-container teardown (V11).** A crashed harness can leave `voltron-stress-*`
  containers running, which a *real* Glimpse would then display. Teardown must be
  in a `finally`/trap that `docker rm -f` by the `voltron-stress-` prefix, and the
  prefix must be distinct from any real agent name so the cleanup can never remove
  a genuine Voltron container.

---

*Methodology only — no harness, test, or `src/`/`public/`/`test/` change is part
of this deliverable. Implementation of the harness is a separate, future task.*
