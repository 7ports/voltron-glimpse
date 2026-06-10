# Voltron Glimpse — Live Monitor Redesign

> **Status:** design only (no code in this document). Supersedes the dashboard
> framing in `docs/implementation-plan.md` §6–§7. The data-contract facts in
> that plan (§2, §3) still hold and are reused here.
>
> **One-line intent:** Glimpse is a live, heavily-animated picture of the Voltron
> agents whose Docker containers are **running right now**, and the (inferred)
> dispatch links between them. Nothing else.

---

## 1. Intent & Non-Goals

### 1.1 What Glimpse is (the entire product)

A single localhost view that answers one question at a glance: **"which agents
are executing this instant, and how are they wired together?"** When an agent's
container starts, a node appears and comes alive; while it runs, it pulses and
its dispatch link flows; when the container exits, the node visibly winds down
and leaves. It is a "watch your swarm work" instrument, not a dashboard.

The view is **ephemeral and present-tense**. It reflects the live set, not
history. Refreshing the page and seeing an empty canvas when nothing is running
is the *correct* behavior, not a bug.

### 1.2 Hard constraints carried over (non-negotiable)

- **Read-only observer.** Never writes any path under `.voltron/` or `.beads/`.
  `docker ps` is a read; we never `docker run/stop/exec`.
- **Localhost only.** HTTP + WS bind `127.0.0.1` exclusively.
- **No build step, no heavy deps.** Node 20 CommonJS backend; vanilla-JS frontend;
  vendored Cytoscape only. The redesign adds **zero** npm or vendor dependencies
  (it actually removes the need for `cytoscape-dagre`/`dagre` on the critical path —
  see §6). The only new external touchpoint is shelling out to the `docker` CLI,
  already anticipated by the `--docker` flag.

### 1.3 Explicitly removed features (the "visual noise")

Every item below is **deleted** from the product, not merely hidden:

| # | Removed feature | Why it goes |
|---|---|---|
| R1 | Overall WORK/PROGRESS tracking — queued/done/blocked tallies, the status-count bar | Glimpse is not a work tracker; the user never wanted progress accounting. |
| R2 | The 6-state work-status model (`queued`/`dispatching`/`working`/`done`/`blocked`/`errored`) | Collapses to a tiny **live-centric** state set (§2.4). `queued`/`blocked` are work-tracking concepts with no live container, so they cannot appear. |
| R3 | Per-phase progress bars | Phases are a planning artifact, not a live signal. |
| R4 | Phase swim-lanes (compound parent nodes / dagre ranks) | The live set is small and changes constantly; lanes fight the animation. |
| R5 | Beads issue/dependency graph as displayed content | Beads describe *declared task ordering*, not *who is running*. Removed from the view entirely. |
| R6 | Journal feed as a primary panel + filter chips (by agent / by phase) | Not wanted; also currently dysfunctional. Optionally retained as a thin, transient "event toast" only (§4.4) — off the critical path. |
| R7 | Analysis indicator + markdown modal | Reading reports is not "watch the swarm." |
| R8 | `progress.json` as a runtime input | It carries no liveness signal. (May be consulted lazily for a node's human-readable description in the detail panel — see §5, "gut" rows — but never to decide membership.) |

**Net:** 7–8 feature areas stripped; the connection/animation core is rebuilt
and 4 new backend modules are added (§5 summary, §7 [DONE]).

### 1.4 Still non-goals (unchanged from original plan)

No state mutation, no Voltron template changes, no multi-project aggregation, no
history persistence, no auth/encryption/remote exposure.

---

## 2. Liveness Detection Design

This is the heart of the redesign: how Glimpse knows, reliably and in real time,
**which agents are running right now** — and how it learns they have stopped.

### 2.1 The authoritative runtime fact

The Glimpse CLI runs on the **host**, not inside a container. Therefore it can
query the host Docker daemon directly. Voltron's dispatched specialist
containers are named:

```
voltron-<agent>-<ISO-ts>-<suffix>
```

which is exactly the **log filename stem prefixed with `voltron-`**. The log
file `.voltron/logs/<agent>-<ISO>-<suffix>.log` and the container
`voltron-<agent>-<ISO>-<suffix>` are two views of the same dispatch instance.
This one-to-one mapping is what lets us fuse the two signals.

> **Important nuance — the orchestrator is not a container.** `scrum-master`
> runs in the user's main Claude Code session **on the host**, so it never
> appears in `docker ps`. The live set is therefore the set of dispatched
> *specialist* containers. The orchestrator is represented as a synthetic hub
> node (§3), not discovered via Docker.

### 2.2 Chosen mechanism: Docker daemon as the source of truth, log tail as the enricher

**Primary (authoritative membership): poll `docker ps`.**

```
docker ps --no-trunc \
  --filter "name=voltron-" \
  --format "{{.ID}}\t{{.Names}}\t{{.CreatedAt}}\t{{.State}}\t{{.Status}}"
```

- Run on the host with `cwd = projectRoot` (cwd is irrelevant to the daemon but
  kept consistent with `bd`).
- Poll cadence: **every 1000 ms** (cheap; one short-lived child process). Each
  poll yields the complete current membership set — this is a *level* signal, so
  a missed tick self-heals on the next one.
- For each running container whose name starts with `voltron-`, the **node id**
  is `Names` with the `voltron-` prefix stripped — identical to the log stem,
  so it joins directly to any log file already being tailed.
- `CreatedAt` gives the dispatch time used for batch grouping and ring ordering
  (§3). `agent` name is derived by stripping the ISO-suffix from the stem, reusing
  the existing `deriveAgentName()` in `src/parsers/logs.js`.

**Why Docker is authoritative and not the log file:** a log file existing — or
even lacking an `[exit]` line — does **not** mean the container is alive. A
crashed/killed container leaves a permanently exit-less log. Only the daemon
knows true liveness. Since the CLI is on the host, we use it.

**Enricher (within-container detail): tail the live container's log.**

Membership decides *which nodes exist*; the log tail decides *what each live node
is doing*. We keep the existing `chokidar` watch on `.voltron/logs/*.log` and the
offset-tracking `tailLog()`:

- `[exec]` → the agent moved from `dispatching` to `working` (richer than Docker's
  coarse "Up").
- `[STEP N] …` / `[DONE] …` → the node's live label (the "what it's doing now"
  line). Best-effort; many micro-agents emit none, in which case the label falls
  back to the agent name + "running".
- `[exit] code=N` → a *fast-path exit signal* (see §2.3) so a node can leave
  within ~120 ms of finishing instead of waiting up to a full Docker poll.

The log tail is **event-driven** (chokidar), so step labels update the instant
they are written — the animated "alive" feel comes from this, between the 1 s
Docker ticks.

### 2.3 How exits are detected (so nodes leave)

A node is removed from the live set when **either** signal fires (whichever is first):

1. **Docker drop (authoritative):** the container's name is absent from a
   `docker ps` poll that previously contained it. This catches *all* exits,
   including crashes/kills that never wrote `[exit]`.
2. **Log `[exit]` (fast path):** an `[exit] code=N` line appears in the tailed
   log. This fires sub-second and also tells us the **exit code** (0 → finished
   ok, ≠0 → errored), which colors the wind-down animation. After emitting the
   fast-path exit we still expect the Docker drop to confirm; the reconciler is
   idempotent (removing an already-removed node is a no-op).

**Wind-down, not snap-out.** On exit the node does *not* vanish instantly. It
transitions to a terminal flash — green for code 0, red for code≠0 — then plays
the exit animation (scale-down + fade) and is removed after a short **linger
(~2.5 s)** so the user perceives the finish. See §4.

### 2.4 Reduced, live-centric state model

The 6-state work model (R2) collapses to four states that can only describe a
*live or just-finished* container:

| Live state | Meaning | Derivation | Visual |
|---|---|---|---|
| `dispatching` | Container is Up but log has no `[exec]` yet (transient, usually <1 s) | Docker says running ∧ no `[exec]` seen | dim blue, gentle fade-in |
| `working` | Actively executing | Docker running ∧ `[exec]` seen, no exit | **vivid green, pulsing** (the dominant state) |
| `exiting:done` | Just finished cleanly (linger window) | `[exit] code=0` or Docker drop with last-known good | bright green flash → shrink/fade |
| `exiting:errored` | Just finished with failure (linger window) | `[exit] code≠0` | red flash → shrink/fade |

There is **no** `queued` and **no** `blocked` — those describe work that has no
running container and therefore no place in a live view.

### 2.5 Fallbacks & graceful degradation

| Condition | Behavior |
|---|---|
| `docker` not on PATH / daemon down | Fall back to **log-freshness heuristic**: a log with `[exec]` and no `[exit]` **whose file mtime is within a freshness window (default 15 s)** is presumed live; once mtime goes stale or `[exit]` appears, it leaves. Surface a clear **"Docker unavailable — inferred from logs"** badge so the user knows membership is approximate. This is explicitly a degraded mode (a stalled-but-alive container with no log output could be missed). |
| `docker ps` errors intermittently | Treat a single failed poll as "no change" (keep prior set); only act on a *successful* poll that omits a container. Never tear down the set on one transient error. |
| Container running but no log file yet | Node still appears (Docker is authoritative); label shows the agent name + "starting", upgraded once the log appears. |
| Log present but container already gone at startup scan | **Not shown.** On startup we seed membership from `docker ps` only; old exit-ed logs are history and are ignored (matches §1.1 present-tense rule). |

### 2.6 Why not the original `--docker`-is-optional stance

`docs/implementation-plan.md` §3 item 6 gated Docker behind an off-by-default
flag to stay "file-based." That tradeoff is now inverted: **live-running is the
product**, so Docker is the *default and primary* path. The flag flips meaning:
`--no-docker` opts **into** the degraded log-freshness fallback (for environments
where querying the daemon is undesirable); Docker introspection is on by default.

---

## 3. Connection Model (edges among the live set)

The user wants "the connections between currently-running agents." We must be
**visually honest** about what is real vs inferred.

### 3.1 What is real vs inferred

| Fact | Source | Real or inferred? |
|---|---|---|
| Which containers are running | `docker ps` | **Real** |
| Each container's agent + dispatch time | container name / `CreatedAt` / log `[entry]` | **Real** |
| Who dispatched whom (parent→child) | *nothing on disk records this* | **Inferred** (per `docs/implementation-plan.md` §3 item 2) |

Dispatch parentage is **not** recorded anywhere. So every dispatch edge in the
graph is inferred and must be drawn as such (dashed, labeled "inferred" in a
one-line legend).

### 3.2 The model: synthetic orchestrator hub + inferred dispatch spokes

1. **Synthetic orchestrator hub (always present while ≥1 agent is live).** A
   single non-container hub node labeled `scrum-master` (the host session that
   dispatches everything). It is not from `docker ps`; it is a fixed anchor so
   the live agents have something to hang off. It disappears when the live set is
   empty.

2. **Dispatch spokes (inferred, dashed, animated).** One edge hub → each live
   agent node. While the target is `working`, the edge **flows** (marching-ants
   `line-dash-offset` animation directed hub→agent) to convey an active dispatch
   relationship. This reuses the *intent* of the original "orchestrator star"
   (`src/model/edges.js`) but restricted to the **live set only** and with no
   batch-bundle math required.

3. **Batch affinity (inferred, visual grouping — not extra edges).** Agents whose
   containers started within a small window (≤3 s, reusing `BATCH_WINDOW_MS`) are
   placed on the **same concentric ring / adjacent angular sector** so a parallel
   dispatch batch reads as a cluster. This is conveyed by *layout*, not by drawing
   agent↔agent edges (which would imply a relationship we cannot prove).

4. **Optional sub-manager attribution (inferred, heuristic — phase-2 refinement).**
   If a Tier-1/Tier-2 container (e.g. `code-analyst`, a sub-manager) is itself
   live, micro-agents that *start during its lifetime* may be attached to it
   instead of the root hub, producing a 2-level tree. This is a heuristic and
   **must stay visibly inferred**; ship the flat hub-and-spoke first (§7) and add
   this only if it reads well. When off, everything hangs off the root hub.

### 3.3 What is explicitly NOT drawn

- **No beads dependency edges** (R5). Declared task dependencies are not "who is
  running," so `dependency` edges are removed from the graph entirely.
- **No agent↔agent dispatch edges** asserting one specialist launched another —
  we cannot prove it from disk, so we do not draw it (batch affinity is shown by
  layout instead).

---

## 4. Animation & Dynamism Spec

The defining quality: **as dynamic and heavily animated as possible.** This is a
live instrument; motion is the point. Cytoscape core (already vendored) supports
per-element `ele.animate()` and `cy.layout({animate:true})`; node CSS keyframes
are *not* supported, so pulses are driven by a JS animation loop. No new vendor
libs are needed.

### 4.1 Node entrance (container appears)

- New node is added at the hub's position with `opacity:0`, `width/height` ~20%
  of target.
- Animate over **~450 ms** to full size + `opacity:1` with an ease-out; emit a
  one-shot **ripple ring** (a brief expanding `overlay-opacity` pulse) so an
  arrival is unmissable.
- Simultaneously its dispatch spoke "draws in" (edge opacity 0→target over the
  same window).

### 4.2 Run pulse (the dominant, always-on motion)

- Every `working` node runs a continuous **breathing pulse**: a JS loop
  (`requestAnimationFrame`, ~1.4 s period) animates `overlay-opacity`
  (≈0.10 ↔ 0.40) and `border-width` (≈3 ↔ 7) in the node's status color.
- Pulses are **phase-jittered per node** (seed the phase from a hash of the node
  id — deterministic, no `Math.random` needed for reproducibility) so the swarm
  shimmers organically instead of blinking in unison.
- Tier scales the pulse amplitude slightly (Tier-1 hub breathes largest) to keep
  the existing tier-as-size language.

### 4.3 Edge flow (active dispatch)

- `working` targets' spokes animate `line-dash-offset` continuously (marching
  ants, hub→agent direction) — a perpetual "data flowing to a busy agent" cue.
- When a node leaves `working`, its edge flow stops and the edge dims.

### 4.4 Exit (container stops) — wind-down

- On exit signal (§2.3): snap to terminal color (green `code 0` / red `code≠0`),
  emit a single **terminal flash** (bright overlay pulse, ~300 ms).
- Then animate scale-down to ~30% + `opacity→0` over **~600 ms**, hold the
  **linger (~2.5 s total from exit)**, then remove the node and its spoke.
- The spoke retracts toward the hub as the node fades (edge opacity → 0).

### 4.5 Layout behavior as the live set changes

- **Layout:** Cytoscape's built-in **`concentric`** (orchestrator hub at center,
  Tier-2 sub-managers on inner ring, Tier-3 micro-agents on outer ring; angular
  order grouped by batch affinity §3.2). `concentric` is in cytoscape core — this
  lets us **drop `cytoscape-dagre`/`dagre` from the critical path** (swim-lanes
  are gone). dagre may remain vendored but unused, or be removed in cleanup.
- **Re-layout on membership change** runs with `animate:true`,
  `animationDuration:~400 ms`, easing — existing nodes **glide** to new positions
  as siblings enter/leave, rather than snapping. Debounce re-layout ~200 ms so a
  burst of simultaneous dispatches settles into one smooth reflow.
- Keep zoom/pan/fit controls; auto-`fit` gently (animated) when the set size
  changes substantially, but never yank the view on every minor update.

### 4.6 Update cadence summary

| Channel | Cadence | Drives |
|---|---|---|
| `docker ps` poll | 1000 ms | membership (enter/exit), dispatch time |
| log tail (chokidar) | event-driven (~120 ms debounce) | `[exec]`/`[STEP]`/`[exit]`, live labels, fast-path exit |
| pulse loop | `requestAnimationFrame` (~60 fps) | working-node breathing, edge flow |
| re-layout | debounced 200 ms; animate 400 ms | reflow on set change |
| WS broadcast | on each domain event | snapshot on connect, deltas after |

---

## 5. Keep / Strip / Add Table

Legend: **keep** = unchanged · **gut** = same file, heavily rewritten/reduced ·
**remove** = delete from runtime (and ideally repo) · **new** = create.

### 5.1 Backend

| Path | Verdict | Detail |
|---|---|---|
| `bin/cli.js` | **gut** | Keep arg-parse, root detection, HTTP/WS bind, browser open, shutdown. Rewire: drop progress/journal/analyses/beads wiring; wire **docker poller → liveness reconciler → bus → state → WS**. Flip `--docker` default ON; add `--no-docker` (fallback) and `--poll <ms>`. |
| `src/projectRoot.js` | **keep** | Root detection still needed (locates `.voltron/logs` + cwd for docker). |
| `src/transport/httpServer.js` | **keep** | Static server unchanged. |
| `src/transport/wsServer.js` | **keep** | Snapshot-on-connect + broadcast unchanged (event constants shrink, see eventBus). |
| `src/eventBus.js` | **gut** | New event set: `AGENT_ENTER`, `AGENT_UPDATE`, `AGENT_EXIT`, `EDGE_UPDATE`. **Remove** `JOURNAL_APPEND`, `PHASE_UPDATE`, `ANALYSIS_ADD`, `COUNTS_UPDATE`, `LOG_UPDATE` (step label folds into `AGENT_UPDATE`). |
| `src/state.js` | **gut** | Model becomes `{ liveAgents:{}, edges:[], dockerAvailable:bool }`. Remove `phases`, `journal`, `analyses`, `counts`. `applyEvent` handles enter/update/exit + edges only. `snapshot()` returns the live set. |
| `src/watcher.js` | **gut** | Keep chokidar but watch **only** `.voltron/logs/*.log` (for `[exec]`/`[STEP]`/`[exit]` enrichment + fast-path exit). Remove routing for `progress.json`, `journal/`, `analyses/`, `.beads/interactions.jsonl`. Keep offset-tracking tail + debounce. |
| `src/parsers/logs.js` | **keep (minor)** | Reused as-is for container/agent-name derivation and `[entry]/[exec]/[STEP]/[exit]` parsing. May trim payload to the live-state vocabulary (§2.4). |
| `src/parsers/progress.js` | **remove** | No liveness signal (R8). (Optionally retain a tiny lazy reader for a node's `description` in the detail panel — if kept, it is read on-demand, never watched.) |
| `src/parsers/journal.js` | **remove** | Feed is gone (R6). Keep only if the optional event-toast (§4.4) is built; then reduce to a thin tail used for transient toasts. |
| `src/parsers/analyses.js` | **remove** | Analyses view gone (R7). |
| `src/parsers/beads.js` | **remove** | Beads graph gone (R5). |
| `src/model/tiers.js` | **keep** | Tier→size still drives ring + node size. |
| `src/model/statusMachine.js` | **gut** | Collapse to the 4 live states (§2.4): `dispatching`/`working`/`exiting:done`/`exiting:errored`. Remove `queued`/`blocked`. |
| `src/model/edges.js` | **gut** | Restrict to the **live set**: synthetic hub + inferred dispatch spokes + batch-affinity grouping metadata. Remove dependency-edge construction and orchestrator-discovery-from-disk. |
| `src/docker.js` | **new** | `pollDocker({cwd})` → runs `docker ps --filter name=voltron- --format …`, parses rows to `[{id,name,nodeId,agent,createdAt,state}]`. Detects daemon-unavailable and reports it. Pure read; never mutates containers. |
| `src/liveness.js` | **new** | The reconciler. Holds the current live set; on each docker poll + log event, diffs against prior set and emits `agent:enter` / `agent:update` / `agent:exit`. Owns the **wind-down linger** timing and the **log-freshness fallback** (§2.5). Calls `edges.js` to (re)build spokes for the live set. |
| `src/pulseClock.js` *(optional)* | **new (optional)** | Backend has no role in per-frame pulsing (that's frontend rAF). Listed only to note: **do not** put animation timing on the backend. |

### 5.2 Frontend

| Path / UI region | Verdict | Detail |
|---|---|---|
| `public/index.html` — `#cy` canvas | **keep (gut layout)** | Becomes the **full-bleed** stage (no sidebar/bottom grid). |
| `public/index.html` — connection badge | **keep** | Add a second pill for **Docker availability** (§2.5). |
| `public/index.html` — graph toolbar (fit/zoom) | **keep** | Still useful. |
| `public/index.html` — legend | **gut** | Reduce to: live states (§2.4) + "dashed = inferred dispatch" + tier=size. Remove status-6, dependency-edge, swim-lane legend entries. |
| `public/index.html` — left sidebar (activity feed + filter chips) | **remove** | R6. Whole `<aside>` deleted. |
| `public/index.html` — bottom panel (status counts, phase bars, active-now strip) | **remove** | R1/R2/R3. Whole `.bottom-panel` deleted. |
| `public/index.html` — `#swimlane-labels` | **remove** | R4. |
| `public/index.html` — analysis modal | **remove** | R7. |
| `public/index.html` — node detail modal | **gut** | Keep a *minimal* hover/click card: agent, container name, dispatch time, current `[STEP]`/`[DONE]`, exit code if exiting. Remove phase/priority/issue-type/beads fields. Prefer a lightweight on-canvas tooltip over a full modal for the live feel. |
| `public/index.html` — vendor scripts | **gut** | Keep `cytoscape.min.js`. `dagre`/`cytoscape-dagre` become **unused** (concentric is core) — drop the `<script>` tags; optionally delete the vendor files in cleanup. |
| `public/cytoscape-style.js` | **gut** | Remove `phase-container`, `dependency`, `queued`, `blocked`, `done`(static) styles. Add vivid `working` base, `dispatching`, `exiting-done`/`exiting-errored`, ripple/flash overlay base, animated dispatch-spoke base. |
| `public/styles.css` | **gut** | Delete the layout grid, sidebar, bottom-panel, phase-bar, chip, feed, analysis-modal styles. Keep/add: full-screen canvas, badges, minimal tooltip, dark stage background, any keyframes for DOM-side flourishes. |
| `public/app.js` | **gut (major rewrite)** | Remove: counts, phases, feed, chips, filters, analysis, swim-lane logic, dagre layout, markdown renderer. Add: live-set reconciliation (`agent:enter/update/exit`), concentric animated layout, the **pulse rAF loop**, entrance/exit/edge-flow animations, Docker-availability badge handling. WS client + backoff reconnect **kept**. |

### 5.3 Tests

| Path | Verdict | Detail |
|---|---|---|
| `test/parsers.test.js` | **gut** | Drop progress/journal/analyses/beads parser tests. Keep log-parser tests (still core). |
| `test/docker.test.js` | **new** | Unit-test `pollDocker` row parsing against a **captured `docker ps` text fixture** (no live daemon needed). |
| `test/liveness.test.js` | **new** | Drive the reconciler with scripted poll sets + log events; assert enter/exit emission, linger timing, fallback path. Pure in-memory, host-independent. |
| `test/fixtures/docker-ps.txt` | **new** | Captured `docker ps` output sample for the above. |
| `test/fixtures/.voltron/{journal,analyses}`, `bd-list.json`, `.beads/` | **remove** | No longer parsed. (Keep `logs/` fixtures.) |

---

## 6. Architecture (revised data flow)

```
 ┌──────────────────────── voltron-glimpse (host process) ───────────────────────┐
 │ cli.js → resolveProjectRoot(cwd)                                               │
 │                                                                                │
 │   ┌─ dockerPoller (1 s) ── docker ps --filter name=voltron- ──┐                │
 │   │                                                           ▼                │
 │   │                                              liveness.js (reconciler)      │
 │   └─ logWatcher (chokidar logs/*.log) ── [exec]/[STEP]/[exit] ─┘   │            │
 │                                                                   │ emits      │
 │                                          agent:enter / :update / :exit, edge   │
 │                                                                   ▼            │
 │                                              EventBus ──► StateModel (live set)│
 │                                                                   │            │
 │                                   ┌───────────────────────────────┤            │
 │                                   ▼                               ▼            │
 │                         WS server (127.0.0.1)            HTTP server (public/) │
 │                   snapshot live set on connect,                                │
 │                   broadcast enter/update/exit deltas                           │
 └────────────────────────────────────────────────────────────────────────────┘
            browser: concentric animated graph, pulse loop, enter/exit transitions
```

The StateModel + EventBus decoupling from the original plan is preserved; only
the *inputs* (Docker + logs instead of five file sources) and the *shape* (live
set instead of work model) change.

---

## 7. Revised Build Order

Small, single-agent-sized steps. Each names its **owner** (`fullstack-dev` /
`ui-designer` / `qa-tester`) and a **verification** note. The unavoidable
constraint: **the Docker-daemon liveness path can only be truly exercised on the
HOST** — an agent running inside a container cannot query the host daemon. So
container-run agents verify via *fixtures and fakes*; the host-only end-to-end
check is called out explicitly and handed to the user/scrum-master.

> Track these as beads issues before implementation (`bd create …`), with the
> dependency chain B1→B2→… as noted.

| # | Task | Owner | Verification (note host-only items) |
|---|---|---|---|
| **B1** | Prune removed backend: delete `parsers/{progress,journal,analyses,beads}.js`, their tests, and stale fixtures; shrink `eventBus.js` to the new event set. | fullstack-dev | `npm test` green with reduced suite; `grep -r` shows no refs to removed modules. Container-safe. |
| **B2** | `src/docker.js`: implement `pollDocker()` + row parser + daemon-unavailable detection. | fullstack-dev | `test/docker.test.js` against `docker-ps.txt` fixture. Parser is pure → **container-safe**. (Live `docker ps` smoke = host-only, deferred to B11.) |
| **B3** | `src/liveness.js`: reconciler diffing poll sets + log events → `agent:enter/update/exit`; linger timer; log-freshness fallback. | fullstack-dev | `test/liveness.test.js` with scripted inputs (fake clock). Pure in-memory → **container-safe**. |
| **B4** | Gut `statusMachine.js` to the 4 live states; gut `edges.js` to hub + live spokes + batch affinity. | fullstack-dev | Unit tests for state derivation + edge set on a sample live set. Container-safe. |
| **B5** | Gut `state.js` to the live model + `snapshot()`; align `wsServer` event names. | fullstack-dev | Unit test: apply enter/update/exit → snapshot reflects live set; WS broadcasts new events. Container-safe. |
| **B6** | Gut `watcher.js` to logs-only; rewire `cli.js` (docker poller + log watcher → liveness → bus → state → WS); flip `--docker` default, add `--no-docker`/`--poll`. | fullstack-dev | Boot with a **fake docker poller** injected (no daemon) → WS emits enter/exit from scripted sets. Full daemon path = **host-only (B11)**. |
| **B7** | Strip frontend DOM: remove sidebar, bottom panel, swim-lane labels, analysis modal; make `#cy` full-bleed; reduce legend; add Docker-availability badge. | ui-designer | Load `index.html` against a **canned WS snapshot**; only canvas + badges + minimal tooltip remain. Browser-checkable in-container via static serve. |
| **B8** | Rewrite `app.js` live core: reconcile `agent:enter/update/exit`, concentric animated layout, WS client (reuse backoff). | fullstack-dev | Feed scripted WS messages from a stub server; nodes appear/disappear correctly; no console errors. Container-safe (stub WS). |
| **B9** | Animation pass: entrance ripple, working pulse rAF loop, edge-flow marching-ants, exit flash + wind-down linger; `cytoscape-style.js` + `styles.css` rework. | ui-designer | Visual check against a **looping scripted scenario** (enter→work→exit) served by a stub; confirm pulse/flow/exit read clearly. Browser-checkable in-container. |
| **B10** | Docs + cleanup: update README/CLAUDE.md to the live-monitor intent; remove unused `dagre`/`cytoscape-dagre` vendor + tags; refresh `implementation-plan.md` cross-refs. | doc-writer | `grep` shows no dangling refs; README matches behavior. Container-safe. |
| **B11** | **HOST-ONLY end-to-end:** run `voltron-glimpse` on the host while a real Voltron sprint dispatches containers; confirm nodes appear on `docker run`, pulse while `[exec]`, and leave on exit within ~1 s; confirm `--no-docker` fallback degrades correctly; **read-only audit** (`grep` no `fs.write*`/`appendFile` under `.voltron`/`.beads`; confirm only `docker ps` reads). | qa-tester → **escalate to user/scrum-master** | Cannot run inside a container (needs host daemon). qa-tester prepares the script + checklist; **the human/scrum-master executes on the host** and reports back. This is the gating acceptance test. |

**Verification principle:** every step B1–B10 is provable inside a container via
**fixtures, fakes, fake clocks, and stub WS servers** — the Docker dependency is
injected, never required, for unit/integration work. Only B11 needs a real host
daemon, and it is explicitly handed off because container-run agents structurally
cannot perform it.

---

## 8. Open Questions (need human input before/within implementation)

1. **Linger duration & exit color** — is ~2.5 s wind-down the right "I saw it
   finish" window, or longer/shorter? Should errored exits linger longer than
   clean ones?
2. **Sub-manager attribution (§3.2 item 4)** — ship the flat hub-and-spoke only,
   or invest in the inferred 2-level tree? (Recommend: flat first.)
3. **Optional event toast (§4.4)** — keep a *thin* transient journal/dispatch
   toast for extra liveness, or remove journal parsing entirely? (Default in this
   plan: remove; revisit if the canvas feels too quiet.)
4. **`--no-docker` default audience** — is the log-freshness fallback worth
   shipping in v1, or is Docker a hard requirement (simpler, but fails on hosts
   where daemon access is restricted)?

---

*Plan saved to `docs/live-monitor-redesign.md`. Invoke `/scrum-master` with this
document to generate the work breakdown (B1–B11).*
