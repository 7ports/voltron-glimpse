# Voltron Glimpse — Implementation Plan

> A standalone, read-only, real-time visualizer companion for Project Voltron and any
> Voltron-based agent project. Runs as a background Node CLI that auto-attaches to the
> Voltron project in the current directory and serves a live graph dashboard on localhost.

---

## Context

Project Voltron is an MCP server / agent orchestrator that dispatches Claude Code agents
into Docker containers and records everything it does to disk under `.voltron/` (plus a
beads/`bd` issue tracker under `.beads/`). Today the only way to follow a run is to read
the scrum-master's chat stream or tail files by hand. **Voltron Glimpse** turns that
on-disk activity into a live, graph-based dashboard: one node per dispatched agent,
color-coded by status, sized by tier, wired together by dispatch relationships, grouped
into phase swim-lanes, with a live activity feed and drill-down panels.

Glimpse is a **separate project** — its own repo, its own npm package — but presented as a
companion to Voltron. It is strictly an **observer**: it never writes Voltron state, never
requires agent-template changes, never aggregates across projects, never persists history
beyond what `.voltron/` already holds, and never authenticates or exposes itself remotely.

This plan was validated against the **actual on-disk data contract** in
`C:\Users\Raj\Documents\nongamerepos\project-voltron`. The most important validation
outcomes (which shaped the design) are called out in **§2 Data Contract** and
**§3 Hard Truths**.

---

## 1. Goals & Non-Goals

**Goal:** `npm i -g voltron-glimpse` (or `npx voltron-glimpse`), then run `voltron-glimpse`
at the root of any Voltron project → a browser opens to a live dashboard that updates as
agents are dispatched and run.

**Decisions locked in (from planning Q&A):**
- **Repo:** new standalone git repo + npm package at
  `C:\Users\Raj\Documents\nongamerepos\voltron-glimpse`.
- **Beads source:** **hybrid** — chokidar watches `.beads/interactions.jsonl`; each change
  triggers a `bd list --json` refresh for full state.
- **Edge model:** **orchestrator star + batch grouping**, with beads task→task dependency
  edges overlaid as a second edge type.
- **Graph library:** **Cytoscape.js** (+ `cytoscape-dagre` for layered/swim-lane layout).

**Non-goals (explicit constraints):** no state mutation, no template changes, no
multi-project aggregation, no history persistence beyond `.voltron/`, no auth/encryption/
remote exposure. Bind the HTTP + WS servers to `127.0.0.1` only.

---

## 2. Data Contract (what Glimpse reads)

All paths relative to the detected **project root** (nearest ancestor dir containing
`.voltron/`).

| Source | Path | Format | Watchable? | Provides |
|---|---|---|---|---|
| **Progress** | `.voltron/progress.json` | JSON `{tasks:[…], updated_at}` | ✅ direct file | task_id, agent, status, **phase**, description, notes, created/started/completed/updated timestamps |
| **Journal** | `.voltron/journal/YYYY-MM-DD.md` | Markdown, append-only, one file per UTC day | ✅ dir glob | activity feed entries |
| **Agent logs** | `.voltron/logs/<agent>-<ISO>-<suffix>.log` | text headers + stream-json + `[STEP N]`/`[DONE]` | ✅ dir glob + tail | per-dispatch lifecycle, steps, exit code, container name (from filename) |
| **Analyses** | `.voltron/analyses/<ISO>-<topic>.md` | Markdown report | ✅ dir glob | analysis indicator + full markdown on click |
| **Beads audit** | `.beads/interactions.jsonl` | JSONL, append-only | ✅ direct file | change trigger → re-poll `bd list --json` |
| **Beads state** | `bd list --json` (CLI) | JSON array | ⛔ Dolt DB; poll via CLI on interactions change | task graph, dependencies, status, priority |

### Exact shapes

**`progress.json`** — `tasks[]` entries:
```json
{ "task_id":"voltron-w4k", "agent":"fullstack-dev", "description":"…",
  "phase":"Phase 1: Audit", "status":"queued|in_progress|completed|failed|blocked",
  "notes":"", "created_at":"ISO", "started_at":"ISO|null",
  "completed_at":"ISO|null", "updated_at":"ISO" }
```

**Journal line** (regex-parseable):
```
**HH:MM** <emoji> `agent_name` [kind] free text…
```
`kind ∈ {session_start, dispatch, task_start, task_complete, validation_pass,
validation_fail, handoff, note, session_recap}`. Map kind→icon for the feed.
Parse with: `^\*\*(\d{2}:\d{2})\*\*\s+(\S+)\s+`([^`]+)`\s+\[(\w+)\]\s+(.*)$`
(date comes from the filename, since lines only carry `HH:MM`).

**Log file** — filename encodes the container:
`voltron-<agent>-<ISO ts>-<suffix>` is the container name; the `.log` is named
`<agent>-<ISO ts>-<suffix>.log`. Body lines of interest:
```
[entry] <ts> host=<hostid> user=<user>     ← container started
[claude-version] <ver>
[exec]  <ts> starting prompt                ← agent began working
[STEP N] <verb> <target> — <result>        ← optional, best-effort
[DONE] <summary>                            ← optional
[exit]  <ts> code=<n>                       ← finished (0=ok)
```
⚠️ Fast micro-agents (e.g. `committer`) emit **only** `[entry]/[exec]/[exit]` — no
`[STEP]`/`[DONE]`. Step labels MUST be best-effort with an exit-code fallback.

**`bd list --json`** entry: `{id, title, description, status(open|in_progress|closed|
blocked), priority(0-4), issue_type, assignee, created_at, updated_at, dependencies:[{
issue_id, depends_on_id, type}]}`.

**`interactions.jsonl`** line: `{id, kind, created_at, actor, issue_id, extra:{field,
old_value, new_value, reason}}` — used only as a *change signal*, not parsed for state.

---

## 3. Hard Truths (validation findings — design around these)

These are the things the user's original architecture assumed exist on disk but **do not**.
The plan handles each explicitly; the implementer must not "fix" them by changing Voltron.

1. **Beads is a Dolt database, not a flat file.** chokidar cannot watch issue state
   directly. → Hybrid: watch `.beads/interactions.jsonl`, debounce, then shell out to
   `bd list --json` (cwd = project root). Degrade gracefully if `bd` is absent.
2. **Dispatch parent/child is NOT recorded anywhere.** No `dispatcher`/`parent` field. →
   Edges are *inferred* (see §6). Be visually honest: dispatch edges are dashed/"inferred",
   beads-dependency edges are solid/"declared".
3. **Tiers are NOT on disk.** They are conceptual tables in Voltron's templates. → Ship a
   **baked-in tier map** in Glimpse (see §6 node sizing) with a sane default (Tier 3) for
   unknown agents.
4. **Prompt files are deleted immediately after dispatch** (`.voltron/tmp/` is ephemeral).
   → The node detail panel cannot show prompt *content* post-run. Show prompt *metadata*
   we can derive (agent name, container name, dispatch time from log filename) and, if a
   `.voltron/tmp/voltron-<agent>-*.md` file still exists (live dispatch), show it; else
   label "prompt not retained".
5. **Steps are optional.** Many agents never emit `[STEP N]`. → "[STEP N]" label falls
   back to phase/status; never assume a step exists.
6. **Container ID/live status is only in the Docker daemon.** Filenames give the container
   *name* and exit code only. → Treat live container introspection (`docker ps`) as an
   **optional enhancement** behind a flag (`--docker`), off by default to honor "file-based,
   read-only". Without it, "done/failed" comes from `[exit] code=`.
7. **Prior art:** `.voltron/dashboard.html` already exists in the Voltron repo — skim it
   for any existing conventions before designing the frontend, but Glimpse is independent.

---

## 4. Architecture & Flow

```
 ┌──────────────────────────────────────── voltron-glimpse (single process) ────────────┐
 │                                                                                        │
 │  cli.js ──► resolveProjectRoot(cwd)  (walk up until .voltron/ found)                   │
 │     │                                                                                  │
 │     ├─► Watcher (chokidar)  ── raw fs change events ──►  Parser / normalizers          │
 │     │     watches: progress.json, journal/*.md, logs/*.log,                            │
 │     │              analyses/*.md, .beads/interactions.jsonl                            │
 │     │                                                                                  │
 │     ├─► EventBus (in-proc EventEmitter) ◄── normalized domain events ──┐               │
 │     │        events: agent:update, edge:update, journal:append,        │               │
 │     │                phase:update, analysis:add, counts:update         │               │
 │     │                                                                  │               │
 │     ├─► StateModel  (single source of truth, in memory)  ─────────────┘               │
 │     │        agents{}, edges[], phases{}, journal[], analyses[], counts{}              │
 │     │                                                                                  │
 │     ├─► WS server (ws, 127.0.0.1)                                                      │
 │     │        on connect → send {type:'snapshot', state}                                │
 │     │        on bus event → broadcast {type:'patch', …delta}                           │
 │     │                                                                                  │
 │     └─► HTTP server (127.0.0.1)  → serves /public static dashboard (index.html + JS)   │
 │                                                                                        │
 │  open(`http://127.0.0.1:<port>`)  (auto-launch browser)                                │
 └────────────────────────────────────────────────────────────────────────────────────┘
```

**Why this shape:** the StateModel + EventBus decouples file parsing from transport.
Frontend reconnects get a full snapshot; subsequent updates are small patches. Everything
is one process, one port, localhost-only.

---

## 5. Repo Layout (to create at `../voltron-glimpse`)

```
voltron-glimpse/
  package.json            # name: voltron-glimpse; bin: { "voltron-glimpse": "./bin/cli.js" }
  README.md               # what it is, install, usage, the §3 limitations stated plainly
  LICENSE
  .gitignore              # node_modules, *.log
  bin/
    cli.js                # arg parse, root detection, wire watcher→bus→state→servers, open browser
  src/
    projectRoot.js        # resolveProjectRoot(startDir): walk up to find .voltron/
    watcher.js            # chokidar setup; emits raw {kind,file} → normalizers
    eventBus.js           # tiny EventEmitter wrapper + event-name constants
    state.js              # StateModel: apply normalized events, expose snapshot()
    transport/
      wsServer.js         # ws server, snapshot-on-connect, broadcast(patch)
      httpServer.js       # static file server for public/
    parsers/
      progress.js         # progress.json → agent/phase/status/counts events
      journal.js          # journal/*.md tail → journal:append events (regex above)
      logs.js             # logs/*.log tail → agent lifecycle/step/exit events + container name
      analyses.js         # analyses/*.md → analysis:add (metadata) + lazy full-markdown read
      beads.js            # interactions.jsonl change → debounce → `bd list --json` → edges/deps
    model/
      tiers.js            # baked-in agent→tier map (see §6) + getTier(name) default 3
      statusMachine.js    # derive node visual-state from progress + log signals (§6)
      edges.js            # build star + batch-group + beads-dep edges (§6)
  public/
    index.html            # layout: graph canvas, left sidebar feed, bottom panel, modals
    app.js                # WS client, Cytoscape init, render snapshot/patches, interactions
    cytoscape-style.js    # node sizing by tier, status color classes, edge styles/animations
    styles.css            # layout grid, swim-lane backgrounds, pulse keyframes, panels
    vendor/               # cytoscape.min.js, cytoscape-dagre.min.js, dagre.min.js (bundled, offline)
  test/
    parsers.test.js       # fixture-driven parser unit tests (node:test)
    fixtures/             # copied real samples: progress.json, a journal .md, log files, interactions.jsonl
```

**Dependencies (minimal):** `chokidar`, `ws`, `open` (browser launch). Dev: none required
beyond `node:test`. Frontend libs vendored in `public/vendor/` (no build step, no bundler —
keeps "static html page" honest and offline-capable).

---

## 6. Core Model Logic

### Node identity — "one node per dispatched agent instance"
Each **log file** = one dispatch instance = one node. Node id = log filename stem (which is
the container name minus the `voltron-` prefix). This gives stable, unique nodes even when
the same agent is dispatched twice. Correlate a node to a `progress.json` task by matching
`agent` name within the dispatch time window (log `[entry]` ts ≈ task `started_at`); when no
log exists yet (queued task), create a "pending" node keyed by `task_id`+agent and upgrade
it to a log-backed node once its log appears.

### Status → visual state (statusMachine.js)
Derive one of six states by combining `progress.json` status with log signals:

| Visual state | Color | Derivation |
|---|---|---|
| **queued** | grey | progress status `queued`, or bead open & no log yet |
| **dispatching** | blue | log has `[entry]` but not yet `[exec]`; transient |
| **working** | green + animated pulse | log has `[exec]`, no `[exit]`/`[DONE]`; or progress `in_progress` |
| **done** | solid green | `[exit] code=0` or `[DONE]`, or progress `completed` |
| **blocked** | orange | progress/bead status `blocked` |
| **errored/failed** | red | `[exit] code≠0` or progress `failed` |

Precedence: explicit failure (red) > blocked (orange) > done (green) > working > dispatching
> queued. Log signals win over stale progress.json when both present.

### Node size → tier (tiers.js, baked-in)
- **Tier 1 (largest):** `scrum-master`, `code-analyst`, `doc-writer`, `project-planner`,
  `reflection-processor`.
- **Tier 2 (medium):** `fullstack-dev`, `csharp-dev`, `devops-engineer`, `qa-tester`,
  `scene-architect`, `ui-designer`, `shader-artist`, `asset-manager`.
- **Tier 3 (smallest):** everything else (the ~51 micro-agents: `committer`, `route-adder`,
  `typecheck-runner`, `dep-reader`, …). Default unknown agents to Tier 3.

> Source the lists from `project-voltron/src/templates.js` tier tables at build time; copy
> them into `tiers.js` as a literal map. Note they're a snapshot — add a README line saying
> to refresh if Voltron adds agents.

### Node label
`"<agent-name>\n[STEP N] <truncated step text>"` where the step is the latest `[STEP N]`
line from the log tail, truncated (~28 chars). Fallback when no steps: show `<status>` or
the task phase. Never render `[STEP undefined]`.

### Edges (edges.js)
Two edge types, visually distinct:
1. **Dispatch edges (inferred, dashed):** orchestrator-as-root star. Identify the
   orchestrator node (a Tier-1 `scrum-master`/`code-analyst`, or the earliest-started
   node if none). Draw root → each agent node. Agents sharing a batch (log `[entry]`
   timestamps within a small window, e.g. ≤3s) are visually grouped (shared edge bundle /
   same rank). Animate (line-dash ripple) while the target node is `working`.
2. **Dependency edges (declared, solid):** from `bd list --json` `dependencies[]`
   (`depends_on_id` → `issue_id`). Map bead ids to nodes via the matching `progress.json`
   `task_id`. These reflect task ordering, not dispatch.

### Phases → swim-lanes
Group nodes by `progress.json` `phase` string. Render each phase as a background region /
horizontal lane (Cytoscape compound parent nodes or styled background rectangles via
dagre ranks). Tasks with no phase → "Unphased" lane. Bottom panel shows a progress bar per
phase (done/total).

---

## 7. Frontend (public/) — UI spec

- **Center: graph canvas** (Cytoscape + dagre). Nodes sized by tier, colored by status,
  pulsing when working, labeled with name + truncated step. Edges as in §6. Pan/zoom/fit.
- **Left sidebar: live activity stream.** Scrolling feed of journal entries (newest at top),
  each with the kind→emoji icon, `HH:MM`, agent, and text. **Filters:** by agent
  (multi-select chips) and by phase. New entries arrive via WS `journal:append`.
- **Bottom panel: status + phases.**
  - Status counts: queued / dispatching / working / done / blocked / failed (live tallies).
  - Per-phase progress bars (done vs total tasks in phase).
  - "Active now" strip: currently-working agents + their latest step.
- **Node click → detail modal:** log tail (last 50 lines of that agent's `.log`), prompt
  metadata (container name, dispatch + exit time, exit code; live prompt file if still
  present, else "not retained"), and container info (name from filename; live status only
  if `--docker`).
- **Analysis indicator → markdown modal:** when an `analyses/*.md` exists, show an indicator
  (e.g. a badge on the related node or a top-bar icon); clicking renders the full analysis
  markdown.
- **Connection status:** small badge showing WS connected/reconnecting; auto-reconnect with
  backoff; on reconnect, replace state from fresh snapshot.

**Styling specifics for the implementer:**
- Status colors as CSS classes toggled on Cytoscape nodes; `working` adds a CSS/Cytoscape
  animation (pulsing border/halo).
- Edge `.active` class drives a `line-dash-offset` animation for the ripple.
- Keep it dependency-free vanilla JS + the vendored Cytoscape; no React/build step.

---

## 8. CLI behavior (`voltron-glimpse`)

- `voltron-glimpse` — detect root from cwd (walk up to `.voltron/`); if none, print a clear
  error ("no .voltron/ found — run inside a Voltron project") and exit non-zero.
- Flags: `--port <n>` (default e.g. 7424; auto-increment if taken), `--no-open` (don't
  launch browser), `--root <path>` (override detection), `--docker` (enable live container
  introspection via `docker ps`, off by default), `--verbose`.
- On start: print the dashboard URL, begin watching, open the browser (unless `--no-open`).
- Runs in foreground until Ctrl-C (it's a "run in the background" tool in the shell sense —
  user backgrounds it). Clean shutdown closes watchers + servers.

---

## 9. Build Order (milestones for the implementing session)

1. **Scaffold repo** at `../voltron-glimpse`: `git init`, `package.json` with `bin`,
   `.gitignore`, README skeleton, install `chokidar ws open`, vendor Cytoscape + dagre.
2. **Project root detection + servers**: `projectRoot.js`, minimal HTTP static server +
   WS server, a hard-coded snapshot → see "hello graph" in browser. Verify localhost-only.
3. **StateModel + EventBus**: define event constants, snapshot()/applyPatch().
4. **Parsers (TDD with real fixtures)** — copy real samples from
   `project-voltron/.voltron/` into `test/fixtures/`, then implement, in order:
   `progress.js` → `logs.js` → `journal.js` → `analyses.js` → `beads.js`. Unit-test each.
5. **Model logic**: `tiers.js`, `statusMachine.js`, `edges.js` (unit-tested).
6. **Wire watcher → parsers → bus → state → WS broadcast** in `cli.js`.
7. **Frontend**: Cytoscape graph (tier sizing, status colors, pulse, swim-lanes) →
   sidebar feed + filters → bottom panel → click modals (log tail, prompt meta, analysis).
8. **CLI polish**: flags, port handling, browser auto-open, graceful shutdown.
9. **README + LICENSE**: usage, screenshots, and the §3 limitations stated honestly.
10. **First commit + push** (new remote).

---

## 10. Verification (end-to-end)

- **Parser unit tests:** `node --test` against fixtures copied from real `.voltron/` files
  (a `progress.json`, a journal `.md`, several `logs/*.log` including a no-`[STEP]`
  `committer` log, an `interactions.jsonl`). Assert correct normalized events.
- **Live smoke test against the real Voltron repo:** run `voltron-glimpse` inside
  `project-voltron` (which has a populated `.voltron/`). Confirm the dashboard loads, nodes
  appear for existing logs/tasks, phases render as lanes, the journal feed populates, and
  filters work.
- **Real-time test:** with Glimpse running, append a line to a `.voltron/journal/<today>.md`
  and edit `.voltron/progress.json` (in a scratch copy / or trigger a real dispatch) →
  confirm the feed and a node update within ~1s without refresh. (Glimpse must never write
  these files itself — verify it only reads.)
- **Beads test:** ensure `bd dolt start` is running (Windows manual-start quirk), then
  confirm `bd list --json` succeeds and dependency edges render; verify graceful degradation
  when `bd` is unavailable (dispatch edges still show; no crash).
- **Reconnect test:** kill/restart the browser tab → WS reconnects and repaints from
  snapshot.
- **Read-only audit:** grep the codebase to confirm no `fs.write*`/`appendFile` targets any
  path under `.voltron/` or `.beads/`.

---

## 11. Risks & Mitigations

- **`bd` not on PATH / Dolt server down (common on Windows after reboot):** beads features
  degrade gracefully; dispatch edges + everything else still work. Surface a soft warning in
  the UI connection badge.
- **Log tailing cost:** debounce + only re-read the tail (track file offsets), don't re-parse
  whole files on every change.
- **Tier map drift:** documented as a snapshot; default unknowns to Tier 3 so new agents
  still render.
- **Inferred edges may mislead:** mitigated by clearly distinguishing dashed "inferred
  dispatch" from solid "declared dependency" edges, and a legend.
- **Windows path/EOL specifics:** the host is Windows; use `path` everywhere and tolerate
  CRLF in journal/log parsing.

---

## 12. Handoff Notes

- This is greenfield in a **new repo** — nothing in `project-voltron` is modified. Do not
  edit Voltron templates, `src/`, or its `.voltron/` (except copying read-only fixtures).
- Reference, don't copy, `project-voltron/.voltron/dashboard.html` for any visual conventions.
- Source the tier lists and the journal `kind→icon` map from `project-voltron/src/templates.js`
  and `src/index.js` at build time and freeze them into Glimpse.
- Keep frontend build-free (vendored libs, vanilla JS) to honor "static html page on localhost."
