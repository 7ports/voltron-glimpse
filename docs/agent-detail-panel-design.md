# Voltron Glimpse — Enriched Agent Detail Panel (Design)

> **Status:** Design / research only — no implementation in this document.
> **Scope:** The card shown when a user clicks (taps) a live agent node. Today it
> is `showTooltip()` in `public/app.js` (the `#node-tooltip` element in
> `public/index.html`). This doc designs a richer version that answers two user
> questions — **"what is this agent doing right now?"** and **"how far along is
> it?"** — *without fabricating data that does not exist on disk.*
> **Honesty mandate:** see §1. No fake percentage. No invented total.

---

## 1. Intent — what "current task" and "how far along" honestly mean

The user wants a node click to reveal more than the current five fields
(`agent`, `containerName`, `createdAt`, `step`, `state`/`exitCode`). Specifically:

- **Current task** — a human-readable answer to *"what was this agent asked to
  do, and what is it doing this second?"*
- **How far along** — a sense of *progress* and *liveness*.

Both must be grounded in data that actually exists. The relevant **Hard Truths**
(from `docs/implementation-plan.md` §3) constrain this hard:

1. **The prompt is gone.** Hard Truth #4: the agent's prompt file under
   `.voltron/tmp/` is deleted immediately after dispatch. The full task prompt is
   **not retained** and cannot be shown. The best available proxy for "the task"
   is the **journal dispatch line** the scrum-master wrote (`Dispatched <agent>
   to <task text…>`), which Glimpse already parses for hub liveness.
2. **There is no total step count.** Hard Truth #5: steps are *optional and
   best-effort*; many agents (e.g. `committer`) emit none. No agent emits a
   declared "N of M" total. Therefore a **determinate progress bar / "% complete"
   is impossible to compute honestly and MUST NOT be shown.** Doing so would
   invent a denominator that does not exist.

### The no-fake-% rule (non-negotiable)

> The panel renders **progress as activity, not as completion.** It may show
> *which* step the agent is on (the step number `N` the agent itself emitted),
> *how long* it has been working (elapsed time), and *that* it is alive (an
> indeterminate activity pulse). It must **never** render a percentage, a
> fraction `N/M`, an ETA, or a determinate (fill-to-100%) progress bar, because
> no honest total exists. "How far along" is expressed as **step counter +
> elapsed clock + indeterminate activity indicator + terminal state**, nothing
> more.

---

## 2. Data inventory — every datum, its source, and whether it exists today

Legend: **✅ exists** = already on the live-agent entry / a patch payload today ·
**🟡 derivable** = the raw value is parsed somewhere but dropped before reaching
the frontend (needs plumbing, no new file reads) · **🔴 new capture** = the
parser/reconciler must retain something it currently discards (still read-only).

| # | Datum (panel needs) | Honest source | Where it lives in code today | Status |
|---|---|---|---|---|
| 1 | **Agent name** | log filename → `deriveAgentName` | `liveAgents[id].agent` (snapshot/enter) | ✅ exists |
| 2 | **Container name** | `docker ps` Names / log stem | `liveAgents[id].containerName` | ✅ exists |
| 3 | **Dispatch / created time** | `docker ps` CreatedAt | `liveAgents[id].createdAt` | ✅ exists |
| 4 | **Live state** | reconciler state machine | `liveAgents[id].state` (`dispatching`/`working`/`exiting:done`/`exiting:errored`) | ✅ exists |
| 5 | **Latest step text** | log `[STEP N] …` / `[DONE] …` | `liveAgents[id].step` (set by `applyLogEvent`) | ✅ exists |
| 6 | **Exit code** | log `[exit] code=N` / Docker drop | `liveAgents[id].exitCode` | ✅ exists |
| 7 | **Tier** | baked-in map | frontend `TIER_MAP` (also `src/model/tiers.js`) — already on node `data('tier')` | ✅ exists (frontend) |
| 8 | **Pod label / self-pod** | `docker inspect` mounts | `liveAgents[id].podLabel` / `.selfPod` | ✅ exists |
| 9 | **Current step *number* `N`** | log `[STEP N]` capture group 1 | `RE_STEP` in `parsers/logs.js` captures `N`, but `parseLog` folds it into the `latestStep` *string* only | 🟡 derivable (parse out of string, or surface as a field) |
| 10 | **Step count seen** | count of `[STEP]` lines tailed | not tracked anywhere | 🔴 new capture (reconciler counter) |
| 11 | **`[exec]` start timestamp** (for "working for Xs") | log `[exec] <ts>` capture group 1 | `RE_EXEC` captures the ts token but `parseLog` **discards** it (only sets `state='working'`) | 🔴 new capture (return + store `execTs`) |
| 12 | **`[DONE]` summary text** | log `[DONE] <summary>` | folded into `latestStep` string as `"[DONE] …"`; survives only until exit linger | 🟡 derivable (already in `step`); optional dedicated `doneSummary` field |
| 13 | **Recent steps (last N)** | the last few `[STEP]` lines | **not retained** — only the single latest step is kept | 🔴 new capture (ring buffer) |
| 14 | **Dispatch task text** ("Dispatched `x` to …") | journal `[dispatch]` line free text | `parsers/journal.js` parses `signal.text`; `liveness.js` `extractDispatchTarget` reads it **only to pull the agent slug** for the flash — the *task text* is discarded | 🔴 new capture (carry text through dispatch correlation onto the entry) |
| 14b | (Note: same correlation that powers `dispatchFlash`.) | — | `pendingDispatches[]` already matches a dispatch line to the entering container (`containerMatches`) | mechanism ✅ exists; only the text is dropped |
| 15 | **Container uptime ("Up 3 minutes")** | `docker ps` Status col | `parseDockerPs` captures `status`, but `applyDockerPoll` does **not** copy it onto the entry | 🟡 derivable (carry `status` onto entry) — *secondary to #11, prefer client-side elapsed* |

**Key finding:** the two questions the user cares about are *answerable*, but the
three richest signals — the **dispatch task text** (#14, the best "current task"
proxy), the **`[exec]` timestamp** (#11, the basis for an honest elapsed clock),
and a **recent-steps list** (#13) — are all parsed-then-thrown-away today. They
need *retention*, not new file access. Everything stays strictly read-only.

---

## 3. Panel content + layout spec

The panel keeps the existing click-to-open / Esc-or-✕-to-close model but is
**pinned** (stays open and live-updates) rather than a transient hover tooltip —
see §5. Layout, top to bottom:

```
┌────────────────────────────────────────────┐
│ ⬤ fullstack-dev                 [tier 2]  ✕ │  ← header: agent + tier chip + close
│   voltron-fullstack-dev-2026-…              │  ← container name (muted, mono)
├────────────────────────────────────────────┤
│ CURRENT TASK                                │  ← section label
│ "Implement the WS snapshot-on-connect        │  ← dispatch task text (journal), or
│  handler and broadcast deltas (B1)"          │     fallback chain (§3.1)
├────────────────────────────────────────────┤
│ ● working          step 7 · 4m 12s          │  ← status line: state + step# + elapsed
│ ┃┃┃┃ (indeterminate activity bar)           │  ← animated, NOT fill-to-% (§3.2)
├────────────────────────────────────────────┤
│ RECENT ACTIVITY                             │
│  7 ▸ edit src/transport/wsServer.js:40 …    │  ← last N [STEP] lines, newest first
│  6 ▸ read src/state.js — found applyEvent   │     (mini live step-log, §3.3)
│  5 ▸ run npm test — 12 passing              │
├────────────────────────────────────────────┤
│ Dispatched  2026-06-11 14:03   ·  pod: you  │  ← meta footer (muted)
└────────────────────────────────────────────┘
```

### 3.1 Current task — precedence / fallback chain

Show the **first** of these that is available (most-specific → least):

1. **Journal dispatch text** (#14) — `"Dispatched `<agent>` to <task>"`, with the
   `Dispatched … to ` prefix stripped to leave the task description. This is the
   single best "what was it asked to do" string. Correlated to the node via the
   existing `pendingDispatches` match that already drives `dispatchFlash`.
2. **`[DONE]` summary** (#12) — once the agent finishes, its own one-line summary
   of what it did is the truest "what this task was."
3. **Latest `[STEP]` text** (#5) — if no dispatch line was captured (e.g. Glimpse
   started mid-run, or the journal line scrolled past the tail window), the
   current step is the best available "doing now."
4. **State label** — `dispatching` / `working` → a plain "container started" /
   "agent running" string (mirrors `defaultLabel` in `parsers/logs.js`).

The panel should **visually distinguish** an *inferred* task line (from the
journal — honest, but a correlation, not a contract) from a *direct* one, matching
the project's existing "inferred = dashed/labelled" honesty convention. A small
"inferred from journal" caption under the task text when source = (1) keeps it
honest.

### 3.2 How far along — the honest progress representation

Three complementary, **non-fabricated** signals, shown together on the status line:

- **Step counter** — `"step 7"`, taken from the agent's own `[STEP N]` number
  (#9). When the agent emits unnumbered `[STEP]`s, show the **count seen**
  (#10) as `"step 3 (seen)"`. When the agent emits no steps at all (e.g.
  `committer`), omit the counter entirely — never show `step 0`.
- **Elapsed clock** — live-ticking `"4m 12s"` since the `[exec]` timestamp (#11),
  falling back to `createdAt` (#3) when `execTs` is absent. The clock ticks
  client-side (one `setInterval` while the panel is open); it does **not** require
  backend traffic.
- **Indeterminate activity indicator** — while `state === 'working'`, an
  *indeterminate* animated bar / spinner (the CSS marching-style stripe, never a
  fill-to-N%). On `dispatching` it is a slower/dimmer pulse; on terminal states
  it is replaced by the outcome chip.
- **Terminal state** — on exit, the bar is replaced by `✔ completed (exit 0)` or
  `✘ errored (exit 137)`, colored to match the node wind-down (`#00e676` /
  `#f44336`). The elapsed clock freezes at its final value.

> Explicitly **ruled out:** `%`, `N/M`, ETA, or any determinate bar. The step
> number is a *position marker*, not a fraction — it must never be divided by an
> assumed total.

### 3.3 Recent activity — mini live step-log

A short scrolling list of the **last N `[STEP]` lines** (suggest **N = 5**),
newest first, so the user sees the agent's recent trajectory rather than a single
frozen line. This requires the reconciler to keep a small ring buffer per entry
(#13). Rendering rules:

- Each row: step number (if present) + the step text, truncated to one line with
  full text on hover/title.
- Live-append as `AGENT_UPDATE`s arrive while the panel is pinned (§5).
- Agents that emit no steps show an empty-state caption: *"This agent reports no
  step output."* (true for many micro-agents — honest, not an error).
- Bounded to N rows; the buffer is **ephemeral** (present-tense rule) — Glimpse
  keeps no history beyond the live window, consistent with the project's
  non-goals.

### 3.4 Meta footer

Low-emphasis: dispatch wall-clock time (`createdAt`), pod label + `you` marker
when multi-pod, tier. The current panel's `Container` / `Dispatched` rows fold
into here. Hub clicks keep their existing orchestrator-detail content unchanged
(this design is about *agent* nodes; the hub already has its own branch).

---

## 4. Required backend changes vs frontend-only

### 4.1 Backend (read-only retention — no new file access)

All changes preserve the hard read-only discipline: they retain values already
being parsed; none adds a write, a new path, or a new shell-out.

| Field on live entry / `AGENT_UPDATE` | Source | Change needed |
|---|---|---|
| `execTs` (string/ms) | `[exec] <ts>` | `parsers/logs.js` `parseLog`: return the `[exec]` timestamp (already matched by `RE_EXEC` grp 1). `liveness.js` `applyLogEvent`: store `entry.execTs` on first transition to `working`; include in the `AGENT_UPDATE` payload + `publicEntry`. |
| `stepNum` (number\|null) | `[STEP N]` grp 1 | `parseLog`: return the numeric `N` alongside `latestStep` (currently only embedded in the string). `applyLogEvent`: set `entry.stepNum`. |
| `stepCount` (number) | count of step lines | `applyLogEvent`: increment a per-entry counter each time a step event arrives. (Covers unnumbered steps.) |
| `recentSteps` (string[], ≤N) | last N `[STEP]`/`[DONE]` | `applyLogEvent`: push onto a bounded ring buffer on `entry`; include (sliced) in `AGENT_UPDATE` + `publicEntry`. **Caveat:** `tailLog` parses only the *new* chunk and `parseLog` keeps only the *last* step in that chunk — so if two steps land in one tail chunk the buffer can miss the intermediate one. Acceptable for a "recent trajectory" view; if exactness is wanted, have `parseLog` return *all* step lines found in the chunk (a small, contained change). |
| `doneSummary` (string\|null) | `[DONE] <summary>` | optional: surface the `[DONE]` text as its own field (it already survives inside `step`). Lets the panel show it as the "current task" fallback (#2) cleanly after exit. |
| `dispatchTaskText` (string\|null) | journal `[dispatch]` line | `liveness.js`: when a `pendingDispatches` entry matches an entering container (the existing `containerMatches` path that sets `dispatchFlash`), also copy `signal.text` (the task prose) onto the entry and into the `AGENT_ENTER` payload. Requires keeping the dispatch *text* on the pending record (today only `{agent, ts}` is stored — add `text`). |
| `status` / uptime (optional) | `docker ps` Status | optional: `applyDockerPoll` copy `c.status` onto the entry. **Lower priority** — client-side elapsed from `execTs`/`createdAt` is preferred and avoids depending on Docker being available. |

State plumbing: `src/state.js` needs no structural change — `AGENT_ENTER`
spreads the whole payload and `AGENT_UPDATE` merges, so new fields flow through
automatically once the reconciler includes them. Confirm `publicEntry()` in
`liveness.js` is extended to whitelist the new fields (it currently lists fields
explicitly, so additions must be added there or they will be stripped from the
snapshot).

### 4.2 Frontend-only

- Replace the transient tooltip with a **pinned, live-updating panel** (§5):
  rework `showTooltip`/`addMetaRow` into a structured render that re-renders on
  `onAgentUpdate`/`onAgentExit` **for the currently-open node**.
- Add the **elapsed clock** `setInterval` (client-side ticking; clear on close).
- Add the **indeterminate activity bar** (pure CSS animation in `styles.css`).
- Add the **recent-steps list** rendering from `entry.recentSteps`.
- Add the **current-task** block with the §3.1 fallback chain + "inferred from
  journal" caption.
- All new visuals are CSS classes in `public/styles.css` + markup in the existing
  `#node-tooltip` container in `public/index.html` (no new vendored libs).

---

## 5. Panel UX — pin, layout, live updates

- **Click-to-pin, not hover.** Hover tooltips can't host a live step-log or a
  ticking clock comfortably and fight touch input. Tap a node → panel opens and
  **stays open**, bound to that `nodeId`. Tap another node → rebind to it. Tap
  empty canvas / ✕ / Esc → close (existing behavior).
- **Live while open.** When `onAgentUpdate` / `onAgentExit` fires for the pinned
  `nodeId`, re-render the panel in place: new step appears at the top of recent
  activity, step counter and status advance, and on exit the activity bar swaps
  to the terminal chip while the elapsed clock freezes. The panel should **not**
  auto-close on exit — the user is reading *why/how it finished*; it closes only
  on explicit dismiss (or when the node is hard-removed after its linger, at
  which point the panel shows a muted "agent has exited" footer or closes — a
  small UX choice to confirm during build).
- **Positioning.** Keep the current "near the tapped node" placement but clamp to
  the viewport so the (now taller) card never overflows the canvas edge.
- **Accessibility.** Preserve `role`, keyboard close (Esc), and `aria-live` on
  the status line so the state/step changes are announced; the indeterminate bar
  is `aria-hidden` (decorative) with the textual `"step 7 · 4m 12s · working"`
  carrying the real signal.

---

## 6. Ordered build order (small, single-agent-sized tasks)

> Each task is sized for one specialist dispatch; verification notes included.
> Tasks 1–3 are backend retention; 4–8 are frontend; 9 is QA. Read-only discipline
> is a hard acceptance criterion on every backend task.

1. **Capture `execTs` + `stepNum` in the log parser.**
   `parsers/logs.js`: return `execTs` (from `RE_EXEC` grp 1) and `stepNum` (from
   `RE_STEP` grp 1) on the parsed payload.
   *Verify:* extend `test/logs.test.js` — a fixture with `[exec] <ts>` yields
   `execTs`; `[STEP 7] …` yields `stepNum === 7`; unnumbered `[STEP]` yields
   `stepNum === null`. `npm test` green.

2. **Retain step trajectory + counts in the reconciler.**
   `liveness.js` `applyLogEvent`: maintain `entry.execTs`, `entry.stepNum`,
   `entry.stepCount` (increment), `entry.recentSteps` (bounded ring, N=5);
   include them in the `AGENT_UPDATE` payload and add them to `publicEntry()`.
   *Verify:* `test/liveness.test.js` — scripted `[exec]` then three `[STEP]`
   events produce `stepCount===3`, `recentSteps` length 3 newest-first,
   `execTs` set once. Assert **no fs write** occurs (existing read-only posture).

3. **Carry dispatch task text onto the correlated entry.**
   `liveness.js`: store `text` on `pendingDispatches` records; on the matching
   container enter, set `entry.dispatchTaskText` and include it in `AGENT_ENTER`
   + `publicEntry()`. Optionally add `doneSummary`.
   *Verify:* `test/liveness.test.js` — a `[dispatch]` journal signal followed by
   a matching `applyDockerPoll` enter yields `dispatchTaskText` on the snapshot
   entry; a non-matching enter leaves it null (best-effort, never wrong).

4. **Restructure the panel render (frontend scaffolding).**
   `public/app.js`: split `showTooltip` into `renderPanel(nodeId)` +
   section builders; store `pinnedNodeId`; keep open across updates.
   *Verify:* manual — click a node, panel opens and stays; click another,
   rebinds; Esc/✕/empty-canvas close. No console errors.

5. **Current-task block with fallback chain.**
   Implement §3.1 precedence (dispatchTaskText → doneSummary → latest step →
   state label) + "inferred from journal" caption.
   *Verify:* manual against a live/seeded run — task text shows for a journaled
   dispatch; falls back to step text when none.

6. **Honest progress line: step counter + live elapsed + indeterminate bar.**
   Add the `setInterval` elapsed clock (from `execTs`/`createdAt`), step counter
   (omit when no steps), and a CSS **indeterminate** activity bar in
   `styles.css`. Terminal chip on exit; clock freezes.
   *Verify:* manual — clock ticks; bar animates while working; on exit shows
   `✔/✘` with frozen elapsed. **Grep/visual check that no `%`, `N/M`, or ETA is
   rendered anywhere** (enforces the no-fake-% rule).

7. **Recent-activity mini step-log.**
   Render `entry.recentSteps` (newest first, N rows, truncated + title);
   live-append on `AGENT_UPDATE`; empty-state caption for no-step agents.
   *Verify:* manual — steps appear top-of-list as they arrive; a `committer`-style
   agent shows the empty-state caption.

8. **Meta footer + viewport clamping + a11y.**
   Move container/dispatch/pod into a muted footer; clamp panel to viewport;
   `aria-live` on the status line, `aria-hidden` on the decorative bar.
   *Verify:* manual — panel never overflows the canvas; VoiceOver/NVDA announces
   state/step changes (or at least the status line has `aria-live`).

9. **QA pass + regression.**
   `@agent-qa-tester`: run `npm test`, confirm read-only posture (no writes under
   `.voltron/`), and a manual live-run smoke test of the panel through
   dispatching → working → done/errored. Confirm the no-fake-% rule by inspection.
   *Verify:* full `npm test` green; checklist signed off.

---

## 7. Summary of decisions

- **"How far along" representation (chosen):** **step counter (the agent's own
  `[STEP N]`, or count-seen for unnumbered steps) + a live-ticking elapsed clock
  (from the `[exec]` timestamp, falling back to container `createdAt`) + an
  *indeterminate* activity bar while working + a terminal outcome chip on exit.**
  No percentage, no `N/M`, no ETA — there is no honest total, so none is shown.
- **"Current task" representation (chosen):** the **journaled dispatch line text**
  (correlated to the node by the existing dispatch-flash mechanism), with fallback
  to the `[DONE]` summary, then the latest `[STEP]`, then the state label — and a
  visible "inferred from journal" caption when the source is the journal.
- **Backend fields to add (read-only retention):** **6** —
  `execTs`, `stepNum`, `stepCount`, `recentSteps[]`, `dispatchTaskText`, and
  `doneSummary` (plus one optional, lower-priority `status`/uptime passthrough,
  not counted in the 6). All are values already parsed and currently discarded;
  no new file reads, no writes.

[DONE] Designed an honest enriched agent detail panel — "how far along" = step counter + live elapsed clock + indeterminate activity bar + terminal chip (explicitly no fake %), "current task" = journaled dispatch text with [DONE]/step/state fallbacks; requires 6 read-only backend retention fields (execTs, stepNum, stepCount, recentSteps, dispatchTaskText, doneSummary). Written to docs/agent-detail-panel-design.md.
