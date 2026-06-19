# Voltron Glimpse — Tier-2 → Tier-3 Dispatch Visibility

> **Status:** design / research only — no implementation in this document.
> **Audience:** `/scrum-master`, which decomposes the **Proposed task breakdown**
> (final section) into agent-sized tasks.
> **Extends:** `docs/live-monitor-redesign.md` §3.2 item 4 (the explicitly
> **deferred** "sub-manager attribution") and §3.1/§3.3 (real-vs-inferred honesty),
> and `docs/pod-distinction-design.md` (self-pod scoping). Builds directly on the
> findings in `.voltron/analyses/tier3-dispatch-visibility-audit.md`, treated here
> as established ground truth.

---

## 1. Problem & established facts

A Tier-2 sub-manager (`fullstack-dev`, `qa-tester`, `devops-engineer`, …) dispatches
Tier-3 micro-agents (`test-writer`, `route-adder`, `committer`, …). **None of those
Tier-3 dispatches appear in the Glimpse graph.** The user wants them shown — clearly
and *honestly*.

### 1.1 What the audit already proved (ground truth)

- **RENDER is sound.** Unknown agents default to Tier 3 (`src/model/tiers.js:28`),
  render as triangles (`public/cytoscape-style.js:128-131`), and nothing in
  `public/app.js` filters by tier. A Tier-3 node *in state* would draw.
- **Primary blocker — DETECTION.** Glimpse only materializes a node from a self-pod
  `voltron-`prefixed **container** (`src/liveness.js:215-301`, scoped at
  `src/pods.js:219`) or a self-pod **log file keyed by its own filename stem**
  (`src/liveness.js:431-451`). `applyLogEvent` requires a *pre-existing* node
  (`src/liveness.js:309-310`), and a parsed log event's `nodeId` is always the log
  **file stem** (`src/parsers/logs.js:104`), never an agent named *inside* a line.
  A dispatch written inside a sub-manager's own log therefore creates nothing.
- **Secondary blocker — MODELING.** `buildLiveEdges` (`src/model/edges.js:31-41`)
  hangs every live agent off the single synthetic `scrum-master` hub. There is no
  Tier-2 → Tier-3 parent edge anywhere.

### 1.2 The decisive empirical fact (confirmed on the host, re-verified here)

A Tier-2 sub-manager dispatched via `run_agent_in_docker` runs as **one container**
and performs the Tier-3 work itself. **No child `voltron-<microagent>` container and
no child log file is produced.** The only on-disk trace of a Tier-2 → Tier-3 dispatch
is **structured content inside the sub-manager's own stream-JSON log**.

> **Consequence:** there is no container or log-file signal to key on. The feature
> must be a **log-inference layer** that mines the parent's log stream, synthesizes
> the child representation, and is scrupulously honest that it is inferred.

### 1.3 What the stream-JSON actually contains (verified against real logs)

Inspecting `/workspace/.voltron/logs/*.log` (e.g.
`fullstack-dev-2026-06-05T21-29-47-cd24v1.log`) shows the dispatch is **not prose** —
it is a structured Claude Agent-SDK tool call. Each line is one JSON event; the
relevant blocks live in `message.content[]`:

**Dispatch START** — an assistant message containing a `tool_use` block:

```jsonc
{ "type": "tool_use",
  "id": "toolu_01VgqVYp5v4fYBg8pef1Q7Xv",   // globally-unique, stable
  "name": "Agent",                            // the SDK sub-agent tool
  "input": {
    "subagent_type": "test-writer",           // ← the Tier-3 child agent
    "description": "Write transport integration test",  // ← short task label
    "prompt": "Create a new file …"
  } }
```

**Dispatch END** — a later `user` message containing a `tool_result` block whose
`tool_use_id` matches the START's `id`:

```jsonc
{ "type": "tool_result", "tool_use_id": "toolu_01VgqVYp5v4fYBg8pef1Q7Xv", … }
```

Verified across the real log corpus:

- `fullstack-dev` logs carry **2–7 `Agent` tool_use blocks** each; `devops-engineer`
  and `code-analyst` also use it. Every `Agent` tool_use's `id` has a **matching
  `tool_result`** later in the same file — a real **start→end lifecycle bracket**.
- The MCP variant `mcp__project-voltron__run_agent_in_docker` also appears as a
  structured tool_use in some logs (same correlation mechanics).
- By contrast, the **word "dispatch" in free text** appears even in `committer` /
  `qa-tester` logs (Tier-3 agents that never dispatch anything) — it is role-prompt
  boilerplate and narration. **Text mining is unusable; structured `tool_use` is
  unambiguous.**

This is the whole basis of the design: **detect the `tool_use`, bracket it with its
`tool_result`, never read prose.**

---

## 2. Signal extraction (`src/parsers/logs.js`)

### 2.1 The parse rule (precise)

Within `collectTextBlobs`'s sibling pass over a stream-JSON line, additionally walk
`message.content[]` for **tool blocks** and emit a dispatch marker **iff**:

| Condition | Rule |
|---|---|
| Block type | `part.type === 'tool_use'` |
| Tool name | `part.name === 'Agent'` **OR** `part.name` ends with `run_agent_in_docker` |
| Child agent | `input.subagent_type` (Agent) **or** `input.agent_type` (run_agent_in_docker) is a non-empty string |
| Identity | `part.id` is present (the `toolu_…` id; required — it is the dedup + correlation key) |

…and emit a **completion marker** iff `part.type === 'tool_result'` and
`part.tool_use_id` is a non-empty string.

Everything else — `Bash`/`Read`/`Edit`/`Write`/`Glob`/`Grep` tool_use, any `text`
block, any occurrence of the word "dispatch" — is **ignored for dispatch detection**.
This is the false-positive firewall: we never look at prose, and we never look at
non-`Agent` tools, so sub-manager `.md` template boilerplate (which literally repeats
"dispatch" many times) can never fire.

> **Why `Agent`, not the word "dispatching":** the audit noted `fullstack-dev`'s log
> had 24 "dispatching" mentions but spawned zero child containers. Those mentions are
> narration. The *actual* dispatches are the 2–7 `Agent` tool_use blocks. The
> structured signal is both **complete** (every real dispatch is one) and **sound**
> (nothing else is one).

### 2.2 New parser output shape

`parseLog(content, filename)` currently returns one consolidated live-state payload
(`src/parsers/logs.js:170`). Add **one additive field**, leaving every existing field
untouched (so `applyLogEvent` and all current tests are unaffected):

```js
// added to the parseLog return object
dispatches: [
  // in document order, as encountered in THIS parsed byte-chunk:
  { kind: 'dispatch:start',
    toolUseId: 'toolu_01Vgq…',
    childAgent: 'test-writer',     // normalized lower-case slug
    description: 'Write transport integration test' },
  { kind: 'dispatch:end',
    toolUseId: 'toolu_01Vgq…' },
]
```

- The parent identity is **implicit**: `parseLog` already derives `nodeId`/`agent`
  from the filename (`:101-104`), so the caller knows the parent nodeId for free.
- The parser stays **stateless and per-chunk** (it only ever sees the bytes appended
  since the last offset — `tailLog`, `:175-208`). It does **not** try to pair
  start↔end; pairing is the reconciler's job (start and end frequently land in
  different tail chunks). The parser just reports raw markers in order.
- Reuse the existing `collectTextBlobs` JSON-tolerance discipline: malformed/partial
  JSON yields no markers, never throws (`:48-64`).
- Add `deriveAgentName`-style normalization for `childAgent` (trim + lower-case) so it
  joins cleanly to `getTier` and the frontend tier map.

### 2.3 Watcher

No watcher change. `src/watcher.js` already tails every in-scope pod's
`.voltron/logs/*.log` into the single `onLogEvent` sink (`:72-92, 279-286`) and the
new `dispatches[]` rides along inside the same payload object that already flows
there. The existing **no-replay** seeding rules apply unchanged (`:237-253`): the
self/foreign log roots are read from offset 0 on first contact, so an in-flight
dispatch present at startup is caught up exactly like an in-flight `[exec]` is — see
§4.2 for how the reconciler keeps that from resurrecting finished dispatches.

---

## 3. State & reconciler (`src/liveness.js`, `src/state.js`)

### 3.1 No new event type

Inferred children flow through the **existing** `AGENT_ENTER` / `AGENT_UPDATE` /
`AGENT_EXIT` events and the existing `EDGE_UPDATE`. `state.js` and `wsServer.js` need
**no new event constants** — only the agent entry shape gains a few fields (§3.4),
which `StateModel.applyEvent` already merges generically
(`src/state.js:34,43`). This keeps the transport layer untouched.

### 3.2 nodeId synthesis & dedup

The child has no container and no log file, so Glimpse mints the id from the **stable
`toolUseId`**, which is globally unique and already the correlation key:

```
childNodeId = 'sub::' + toolUseId          // e.g. 'sub::toolu_01Vgq…'
```

- The `sub::` prefix guarantees no collision with container-derived nodeIds (which are
  `voltron-`-stem strings) or with the hub id.
- **Dedup is automatic**: re-tailing never re-reads bytes (offset tracking), and even
  if it did, keying on `toolUseId` makes a second `dispatch:start` for the same id a
  no-op. The reconciler holds a `Map<toolUseId, childEntry>` exactly as it holds
  `liveAgents`.

### 3.3 Parentage (the relationship the user asked for)

`parseLog` reports the dispatch against the **parent log's nodeId**. The reconciler
records that on the child entry as `parentNodeId`. A child is only admitted when its
parent is a **currently-live, container-backed node** in `liveAgents`:

- **Parent live →** create the inferred child, set `parentNodeId = <parent nodeId>`.
- **Parent unknown / already exited →** **drop the dispatch.** Do not fall back to the
  `scrum-master` hub — attaching an orphan child to the hub would assert a dispatch
  relationship we cannot honestly claim (redesign §3.3). Silent drop is the honest
  choice; log a debug counter only.

This produces the 2-level tree the redesign deferred (§3.2 item 4): hub → Tier-2
(container, real spoke-as-inferred) → Tier-3 (synthesized child, sub-dispatch edge).

### 3.4 New reconciler method + entry fields

Add `applyDispatchEvents(parentNodeId, dispatches)` to the reconciler
(`createReconciler`, `src/liveness.js:60`), called by the CLI right after
`applyLogEvent` for the same parsed payload:

```js
function applyDispatchEvents(parentNodeId, dispatches) {
  const parent = liveAgents.get(parentNodeId);
  for (const d of dispatches || []) {
    if (d.kind === 'dispatch:start') {
      if (!parent || parent.exitScheduled) continue;        // §3.3 honesty gate
      const id = 'sub::' + d.toolUseId;
      if (liveAgents.has(id)) continue;                      // dedup
      const entry = { nodeId: id, agent: d.childAgent, parentNodeId,
                      inferred: true, containerBacked: false,
                      podKey: parent.podKey, podLabel: parent.podLabel,
                      selfPod: parent.selfPod, observed: parent.observed,
                      state: 'working',                      // §4.1
                      dispatchTaskText: d.description || null,
                      lastSeen: clock.now(), exitScheduled: false, … };
      liveAgents.set(id, entry);
      bus.emit(EVENTS.AGENT_ENTER, publicEntry(entry));      // carries inferred:true
      recomputeEdges();
    } else if (d.kind === 'dispatch:end') {
      const id = 'sub::' + d.toolUseId;
      handleExit(id, 0);                                     // authoritative wind-down
    }
  }
}
```

`publicEntry` (`src/liveness.js:131-156`) gains three pass-through fields so the WS
snapshot carries them to the browser:

```js
parentNodeId: e.parentNodeId != null ? e.parentNodeId : null,
inferred:     e.inferred === true,
containerBacked: e.containerBacked !== false,   // false ⇒ no docker proof
```

Container-backed real agents leave `parentNodeId` null and `inferred` false, so their
payloads are byte-for-byte what they are today (back-compat).

### 3.5 Why the reconciler, not the parser, owns pairing

Start and end markers arrive in **different tail chunks** (the child runs for seconds
to minutes between them). The parser is per-chunk and stateless; only the reconciler
holds the `liveAgents` map across ticks, so it is the correct owner of
start↔end correlation, dedup, and lifecycle timers — mirroring exactly how it already
fuses per-poll Docker membership with per-chunk log enrichment (`:215-301, 306-382`).

---

## 4. Lifecycle (the hardest part — when the inferred child appears and leaves)

A container node has an authoritative *level* signal (`docker ps` presence). The
inferred child has **no such signal** — only two *edge* events (start, end) that may
be far apart, plus the risk that the end is never observed (crash, Glimpse started
mid-dispatch, log truncation). The lifecycle therefore uses **three independent
removal triggers, whichever fires first** — the same defense-in-depth pattern the
container path already uses (`docker drop` ∨ `[exit]`, §2.3 of the redesign).

### 4.1 Appearance

- On a `dispatch:start` whose parent is live (§3.3): child enters directly in
  **`working`** state. There is no `dispatching` phase — by the time the `tool_use` is
  written, the child sub-agent is already executing; a `dispatching` state would imply
  a container spin-up that does not exist.
- Entrance animation reuses §4.1 of the redesign (scale+fade+ripple) but with the
  inferred visual treatment (§5).

### 4.2 Wind-down — three triggers

1. **Completion (authoritative).** A `dispatch:end` with the matching `toolUseId`
   calls `handleExit(childNodeId, 0)` → the existing terminal flash + linger + removal
   path (`src/liveness.js:185-211`). This is the common, clean case.

2. **Parent exit (cascade — a child cannot outlive its parent).** When a parent
   container winds down (`handleExit` on the parent), **cascade-exit every live child
   whose `parentNodeId === parent.nodeId`.** Rationale: the child ran *inside* the
   parent's process; once the parent's container is gone, any still-"open" inferred
   child is stale by definition. Implement as a small loop inside `handleExit` (or its
   removal callback) that schedules the children's wind-down too. This single rule is
   what makes the feature safe against the **startup catch-up**: when Glimpse starts
   mid-session and reads a whole parent log from offset 0, any dispatch whose `end`
   marker is also in those bytes pairs-and-exits immediately, and any dispatch left
   "open" is bounded by the parent's own lifetime.

3. **TTL fallback (stall guard).** Each child carries `lastSeen`. If neither a
   completion nor a parent-exit has arrived within **`subagentTtlMs` (default 90 000
   ms)** of `lastSeen`, wind the child down as an *unknown-outcome* exit
   (`handleExit(id, null)` → colored as a clean finish, like a Docker drop with no
   `[exit]`). This covers a never-observed `tool_result` (parent crash before writing
   it, log rotation, truncated tail). 90 s is comfortably longer than typical
   micro-agent runtimes yet short enough that a leaked node does not linger visibly.
   Make it a CLI flag (`--subagent-ttl <ms>`) alongside `--poll`.

> **Ordering note.** Triggers are idempotent: `handleExit` already early-returns if
> `exitScheduled` (`:188`), so a completion that arrives just after a TTL sweep (or a
> parent cascade) is a harmless no-op. No trigger can double-remove.

### 4.3 Refresh

A repeated `dispatch:start` for an already-live child (should not happen given unique
ids, but defensive) just refreshes `lastSeen`. There is no per-step enrichment for
inferred children — they emit no `[STEP]` of their own into the parent log — so their
node label is `<childAgent>` + the dispatch `description` (from §2.2), shown as the
"current task" with an **"inferred from parent dispatch"** honesty caption (reusing
the existing caption mechanism, `public/app.js:1054-1059`).

---

## 5. Edge model (`src/model/edges.js`)

### 5.1 A distinct, honest edge kind

`buildLiveEdges` (`src/model/edges.js:31-41`) currently maps every live nodeId to one
`HUB_ID → nodeId` spoke. Change it to branch on parentage:

```js
function buildLiveEdges(liveAgents) {
  const entries = entriesOf(liveAgents);        // need entries, not just ids
  const ids = new Set(entries.map(e => e.nodeId));
  const edges = [];
  for (const e of entries) {
    if (e.inferred && e.parentNodeId && ids.has(e.parentNodeId)) {
      // Tier-2 → Tier-3: child hangs off its REAL parent, never the hub.
      edges.push({ id: `${e.parentNodeId}->${e.nodeId}`,
                   source: e.parentNodeId, target: e.nodeId,
                   kind: 'subdispatch', inferred: true });
    } else if (!e.inferred) {
      // unchanged: hub → real container
      edges.push({ id: `${HUB_ID}->${e.nodeId}`,
                   source: HUB_ID, target: e.nodeId,
                   kind: 'dispatch', inferred: true });
    }
    // an inferred child whose parent is NOT in the set draws NO edge (honesty).
  }
  return edges;
}
```

`nodeIdsOf` becomes `entriesOf` (must read `inferred`/`parentNodeId`, so it needs the
entry objects — the Map and array-of-entries inputs already carry them; the
array-of-strings input simply yields no inferred children, which is correct).

### 5.2 Visual honesty: three honesty tiers, three line treatments

| Relationship | Truth | Edge `kind` | Drawn as |
|---|---|---|---|
| pod boundary (mount source) | **real** | (compound box, `pod-distinction-design.md`) | **solid** box |
| hub → Tier-2 container | inferred parentage, real container | `dispatch` | dashed blue, marching-ants when working |
| Tier-2 → Tier-3 sub-agent | inferred parentage **and** no container proof | `subdispatch` | **dashed, distinct hue (violet), thinner, lower base opacity** |

The `subdispatch` edge must read as "even less certain" than the hub spoke, because we
infer *both* the relationship *and* the child's very existence. A different hue
(violet `#9c6ade`, distinct from the blue dispatch dash and the green working flow)
plus a `[?]`-style legend entry communicates that.

---

## 6. Frontend (`public/app.js`, `public/cytoscape-style.js`)

### 6.1 Inferred-child node treatment

The audit confirms a tier-3 triangle would already draw (`cytoscape-style.js:128`).
Add an **`inferred-agent`** class (set in `upsertNode` when `entry.inferred === true`,
`public/app.js:535-597`) layered on top of the tier3 triangle:

- **Ghosted fill** — lower `background-opacity` (≈0.55) and a **dashed border**, so it
  reads as "not a real container" at a glance. This is the node-level analogue of the
  dashed edge.
- A small **"⌁ no container"** affordance in the detail panel meta grid
  (`buildAgentMeta`, `public/app.js:1283-1296`): a `Backed by` row reading
  `inferred from parent log (no container)`.
- The node label stays `<childAgent>` + truncated description; the detail panel's
  "Current task" shows the dispatch `description` with the existing **"inferred"**
  caption (`public/app.js:1024-1036, 1054-1059`).

### 6.2 Sub-dispatch edge style

Add `edge.subdispatch` to `public/cytoscape-style.js` (sibling of `edge.dispatch`,
`:217-239`): dashed, violet, `width: 1.2`, base `opacity: 0.40`, and an `.active`
variant the rAF loop drives (marching-ants) **only while the child is `working`**
(start seen, no end). Extend the rAF flow loop (`public/app.js:818-847`) to treat
`subdispatch` edges the same as `dispatch` edges for the flow animation, keyed on the
child's `working` class.

### 6.3 Parentage-aware wiring

`setEdges` (`public/app.js:608-634`) and `ensureSpoke` (`:638-656`) assume the source
is the hub. Generalize them to honor an edge's `source` as-given when `kind ===
'subdispatch'` (source is the parent node, which already exists because §3.3 only
admits children of live parents). The exit/entrance spoke animations
(`animateNodeEntrance` `:915-921`, `animateNodeExit` `:943-955`) must look up the edge
by `parentNodeId` for inferred children instead of the hub id.

### 6.4 Clutter control at high agent counts

A busy `fullstack-dev` fans out 5–7 children; several sub-managers at once could mean
dozens of triangles. Three honest, layout-only mitigations (no data dropped):

1. **Per-parent fan cap with a "+N more" pill.** When a parent has more than
   **`SUBAGENT_FANOUT_MAX` (default 6)** live children, render the 6 most-recent and
   collapse the rest into a single small **"+N"** badge node attached to the parent.
   Clicking it expands. The cap is a *display* choice; state still holds them all.
   `log()`/console-note the collapse so it is never silent (redesign "no silent caps"
   principle).
2. **Level-of-detail.** The existing `min-zoomed-font-size` (`:58`) already hides child
   labels when zoomed out; inferred children additionally **shrink one step smaller**
   than a normal tier3 so a dense sub-tree reads as a cluster, not a wall of text.
3. **Layout.** Children attach to their parent in the existing `breadthfirst` radial
   layout (`runLayout`, `:706-775`) — because they hang off the parent node, the layout
   already nests them as a depth-2 ring around the parent with no new layout code.

---

## 7. Risks, false positives & non-goals

### 7.1 False-positive analysis

| Risk | Mitigation |
|---|---|
| Role-template `.md` prose says "dispatch" repeatedly | **Eliminated by construction** — we parse only structured `tool_use` blocks in *logs*, never template files, never text blobs. |
| The narration word "dispatching" in a `[STEP]` line | Ignored — `dispatch:*` markers come **only** from `tool_use`/`tool_result`, not `text`. |
| A non-dispatch tool (`Bash`, `Edit`, …) | Excluded by the `name === 'Agent' \|\| …run_agent_in_docker` gate (§2.1). |
| `subagent_type` values that aren't "real work" (`general-purpose`, `Explore`, `Plan`) | These **are** genuine child agents and *should* show; tier map defaults them to 3. Not a false positive. |
| Orphan child (parent not live / foreign pod) | Dropped, never hub-attached (§3.3) — no dishonest edge. |
| Glimpse started mid-dispatch; `end` already in catch-up bytes | Pairs-and-exits in the same reconcile; parent-cascade + TTL bound any leftover (§4.2). |
| Duplicate `tool_use` id across re-tails | `toolUseId`-keyed dedup (§3.2). |

### 7.2 Known limitations (documented, accepted)

- **No child step output.** Inferred children emit no `[STEP]`/`[exec]` of their own
  into the parent log, so they show task + state only — never a live step counter.
  This is honest: there is no finer signal on disk.
- **TTL is a heuristic.** A pathological child running >90 s with no `tool_result` and
  a still-live parent could be wound down early then never re-shown. Tunable via
  `--subagent-ttl`; the parent-cascade rule makes this rare.
- **Nested dispatch (Tier-3 dispatching Tier-3).** Micro-agents generally cannot
  dispatch, so depth is capped at 2 in practice. If a child's log ever contained an
  `Agent` tool_use, it would not be mined (children have no log file). Out of scope.

### 7.3 Explicit non-goals

- **NOT** a work/history tracker — inferred children are present-tense and ephemeral,
  exactly like container nodes (redesign §1.1).
- **NOT** a claim of a real container — the ghosted node + dashed `subdispatch` edge
  exist precisely to avoid implying one.
- **NO** writes anywhere; this is pure additional **reading** of logs already tailed.
  Never write under `.voltron/` or `.beads/`.
- **NO** Voltron template / launcher changes; we infer from existing log output only.

### 7.4 Open questions (need human input)

1. **TTL value** — is 90 s the right stall-guard window, or should it scale with the
   child agent type (a `test-runner` may run longer than a `committer`)?
2. **Fan-out cap** — is 6 children-before-collapse the right default, or should the
   collapse be zoom-driven only?
3. **Show orphan children at all?** Current recommendation: **drop** (honesty). The
   alternative — show them parented to the hub with a distinct "orphan" style — is
   rejected as dishonest but flagged in case the user prefers "never hide a dispatch."
4. **`run_agent_in_docker` parity** — confirm the MCP variant's input field name
   (`agent_type` vs `subagent_type`) against a live capture before relying on it; the
   `Agent` tool is the verified primary path.

---

## 8. Data-flow summary

```
parent container log (.voltron/logs/<parent>.log, stream-JSON)
   │  watcher tail (offset-tracked, no-replay) — UNCHANGED
   ▼
parseLog()  ──►  { …live-state…, dispatches:[ {start,toolUseId,childAgent,desc}, {end,toolUseId} ] }   ◄ §2
   │  (parser: structured tool_use/tool_result only; never prose)
   ▼
reconciler.applyDispatchEvents(parentNodeId, dispatches)                                              ◄ §3,§4
   │  • start → synth child 'sub::<id>', parentNodeId, inferred, state:working   (iff parent live)
   │  • end   → handleExit(child, 0)            ┐
   │  • parent exit → cascade-exit children     ├─ whichever first  (§4.2)
   │  • TTL since lastSeen → handleExit(child)  ┘
   ▼
EVENTS.AGENT_ENTER / _UPDATE / _EXIT  (existing) + EDGE_UPDATE                                        ◄ §3.1
   ▼
StateModel (generic merge — UNCHANGED)  ──►  WS snapshot/patch  ──►  browser
   ▼
edges.buildLiveEdges: parent→child 'subdispatch' (dashed violet) vs hub→agent 'dispatch'             ◄ §5
   ▼
app.js: ghosted 'inferred-agent' triangle + subdispatch edge + fan-out cap + honesty caption          ◄ §6
```

---

## Proposed task breakdown

Discrete, single-agent-sized tasks for `/scrum-master`. Each names its target
file(s), a one-line acceptance criterion, and dependencies. T1–T4 are backend and
fully verifiable in-container via fixtures/fakes; T5–T7 are frontend; T8 is the
host-only gate. Owners suggested in parentheses.

| # | Task | Target file(s) | Acceptance criterion (one line) | Depends on |
|---|---|---|---|---|
| **T1** | Capture a real dispatch fixture: a trimmed stream-JSON log containing ≥2 `Agent` tool_use blocks and their matching `tool_result`s (one paired, one start-only). | `test/fixtures/.voltron/logs/submanager-dispatch.log` (new) | Fixture file exists with both a completed and an in-flight `Agent` dispatch. | — |
| **T2** | Extend `parseLog` to emit the additive `dispatches[]` array from structured `tool_use`(`Agent`/`…run_agent_in_docker`) + `tool_result` blocks only; ignore text/other tools. Normalize `childAgent`. | `src/parsers/logs.js` | New unit test: fixture yields exactly the expected `dispatch:start`/`dispatch:end` markers; a "dispatch"-in-text line and a `Bash` tool_use yield none; existing logs tests still pass. (fullstack-dev) | T1 |
| **T3** | Add `applyDispatchEvents(parentNodeId, dispatches)` to the reconciler: synth `sub::<id>` child (working) only when parent live; dedup by id; pass-through `parentNodeId`/`inferred`/`containerBacked` in `publicEntry`. | `src/liveness.js` | `test/liveness.test.js`: a start under a live parent emits `AGENT_ENTER` with `inferred:true,parentNodeId`; a start under an absent parent emits nothing. (fullstack-dev) | T2 |
| **T4** | Implement the three wind-down triggers: `dispatch:end` → exit; parent `handleExit` cascades to its children; TTL (`subagentTtlMs`, default 90 000, `--subagent-ttl` flag) sweep on `lastSeen`. | `src/liveness.js`, `bin/cli.js` (flag + wiring `applyDispatchEvents` after `applyLogEvent`) | `test/liveness.test.js` (fake clock): child exits on end; on parent exit; and on TTL lapse — each independently, idempotently. (fullstack-dev) | T3 |
| **T5** | Branch `buildLiveEdges` on parentage: inferred child → `subdispatch` edge to its live parent; real agent → unchanged hub `dispatch`; orphan child → no edge. Switch helper to read entries. | `src/model/edges.js` | Unit test: two-pod/parent live set yields a `subdispatch` parent→child edge and unchanged hub spokes; orphan child yields no edge; pure-string input unchanged. (fullstack-dev) | T3 |
| **T6** | Render inferred children: `inferred-agent` ghosted/dashed triangle, `subdispatch` violet dashed edge with rAF flow while child working, parentage-aware `setEdges`/`ensureSpoke`/entrance/exit wiring, detail-panel "Backed by: inferred (no container)" + task caption. | `public/app.js`, `public/cytoscape-style.js` | `node --check public/app.js`; scripted two-level WS scenario shows a ghosted child on a violet dashed edge under its parent; no console errors. (ui-designer) | T5 |
| **T7** | Clutter control: per-parent fan-out cap (`SUBAGENT_FANOUT_MAX`, default 6) with a "+N" pill node, one-step-smaller inferred children, console-note on collapse; legend entry "dashed violet = inferred sub-dispatch (no container)". | `public/app.js`, `public/cytoscape-style.js`, `public/index.html` (legend) | Scripted scenario with 9 children under one parent renders 6 + a "+N" pill; legend lists the sub-dispatch entry. (ui-designer) | T6 |
| **T8** | **HOST-ONLY** end-to-end + read-only audit: run a real sprint where a Tier-2 dispatches Tier-3s; confirm ghosted children appear on dispatch and leave on completion/parent-exit; `grep` confirms zero `fs.write*` under `.voltron/`/`.beads/`. | (verification only) | On the host, Tier-3 dispatches appear and wind down honestly; read-only audit passes. Escalate to user/scrum-master — cannot run in-container. (qa-tester → user) | T6, T7 |

**Verification principle (carried from redesign §7):** T1–T7 are provable in a
container via fixtures, fakes, and fake clocks; only T8 needs a live host daemon and a
real dispatch, so it is handed off explicitly.

---

*Design saved to `docs/tier2-tier3-dispatch-visibility.md`. Invoke `/scrum-master`
with this document to decompose the **Proposed task breakdown** (T1–T8) into a work
plan.*
