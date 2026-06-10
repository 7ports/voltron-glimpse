# Scrum-Master (Orchestrator) Live Monitor — Design

> **Status:** Design / research only — no implementation in this document.
> **Supersedes:** nothing. **Extends:** `docs/live-monitor-redesign.md` §3.2 (the
> synthetic orchestrator hub). This feature *enriches* the existing static hub
> anchor with live activity; it does not reintroduce the work-tracking panels,
> swim-lanes, or journal feed that the v2 redesign deliberately deleted.
> **Audience:** `/scrum-master`, which decomposes §6 into agent-sized tasks.

---

## 1. Intent

### The gap

Voltron Glimpse v2 visualizes only the **containerized specialist agents** it
discovers via `docker ps` (`docs/live-monitor-redesign.md` §2.2). But the
**scrum-master orchestrator runs in the user's main Claude Code session on the
host**, not in a container — so it never appears in `docker ps`. Today it is
drawn as a purely static synthetic hub: `src/model/edges.js` uses `HUB_ID =
'scrum-master'` only as an *edge source*, and the frontend's `ensureHubNode()`
(`public/app.js`) creates a fixed tier-1 anchor with a hard-coded label. The hub
never pulses, never changes label, and vanishes the moment the live container set
is empty — even though the orchestrator is doing a great deal of work (reading the
backlog, decomposing, dispatching, journaling, polling `bd`) precisely in those
gaps between container lifetimes.

### What this feature does

Surface the orchestrator's **own present-tense activity** by turning the hub from
a static anchor into a live node whose state and label are inferred from the one
real-time signal the scrum-master writes to disk: its **journal**
(`.voltron/journal/YYYY-MM-DD.md`). The hub:

- **pulses (active)** while the orchestrator has journaled recently,
- **dims (idle)** when the journal has gone quiet,
- shows a **"what it's doing now" label** drawn from the latest journal entry,
- can **flash a dispatch spoke** when it journals a `dispatch` entry that
  correlates to a container appearing moments later,
- and may **appear even with zero live containers** when the orchestrator is
  journal-active (e.g. mid-decomposition before the first `docker run`).

### Non-goals (no work-tracking revival)

This feature stays strictly inside the live-monitor intent — **present-tense,
ephemeral, read-only, animated**. It explicitly does **not**:

- restore the deleted journal **feed/timeline**, progress panels, phase
  swim-lanes, or the beads dependency graph (v2 R5, redesign §3.3);
- accumulate or retain journal **history** in state — only the *latest* entry and
  a freshness timestamp are held;
- read `progress.json`, `.beads/`, or `bd list` — the journal file alone is the
  orchestrator-liveness signal;
- introduce progress bars, counts, or status text beyond a single ephemeral
  activity label that disappears when the orchestrator goes idle;
- assert anything the disk does not actually record (see §5 honesty constraints).

---

## 2. Available signals + chosen liveness mechanism

### 2.1 Signals the scrum-master actually emits on disk in real time

| Signal | Path | Real-time? | Usable as orchestrator-liveness? |
|---|---|---|---|
| **Journal append** | `.voltron/journal/YYYY-MM-DD.md` | ✅ append-only, one line per orchestrator action | **Yes — chosen.** mtime = "active recently"; last line = "doing now" |
| `progress.json` write | `.voltron/progress.json` | ✅ rewritten on `update_progress` | Rejected — work-tracking surface; reintroducing it pulls back the deleted panel model |
| `[STEP N]` notifications | (forwarded as MCP notifications) | ✅ but **not reliably on disk** | Rejected — not a file Glimpse can watch read-only |
| `.beads/interactions.jsonl` | `.beads/` | ✅ | Rejected — Dolt/`bd` coupling, work-tracking, often down on Windows |

**Journal line format** (`docs/implementation-plan.md` §2):

```
**HH:MM** <emoji> `agent_name` [kind] free text…
```
Parse regex:
```
^\*\*(\d{2}:\d{2})\*\*\s+\S+\s+`([^`]+)`\s+\[(\w+)\]\s+(.*)$
```
`kind ∈ {session_start, dispatch, task_start, task_complete, validation_pass,
validation_fail, handoff, note, session_recap}`. The date comes from the
**filename** (lines carry only `HH:MM`). In practice every line's `agent_name` is
`scrum-master` — the journal *is* the orchestrator's activity log — so the hub
consumes the whole file; entries are optionally filtered to `agent_name ===
HUB_ID` for safety.

### 2.2 Chosen mechanism: journal mtime as the liveness clock, last line as the label

Mirror the existing two-part pattern Glimpse already uses for containers
(authoritative membership + enriching tail), but for a single synthetic node:

1. **Liveness (freshness window).** The orchestrator is **active** iff the
   newest journal append happened within `hubFreshnessMs` of now. The cheap
   trigger is the **today-file mtime**; a chokidar `change` event on the journal
   directory fires on every append. Because no filesystem event fires when the
   orchestrator simply *stops* writing, an **idle-tick timer** (reuses the
   existing poll cadence) re-evaluates freshness and flips `active → idle` once
   the window lapses with no new append.

2. **Label (tail the appended bytes).** On each append, offset-track and parse
   **only the new bytes** (same discipline as `src/parsers/logs.js` `tailLog`),
   take the **last recognizable entry**, and use its `kind` + free text as the
   hub's "doing now" label.

**Freshness window choice.** Container liveness uses `freshnessMs = 15000`
(`src/liveness.js`). Orchestrator activity is **burstier and gappier** than a
running container — it reads, thinks, and decomposes for tens of seconds between
journal writes. Recommend a **larger window, `hubFreshnessMs ≈ 60000` (45–90 s)**,
configurable via a new `--hub-freshness <ms>` flag (default 60000). This avoids
flickering the hub to idle during a normal decompose-then-dispatch gap.

**Today-file rollover.** At UTC midnight the orchestrator starts a new
`YYYY-MM-DD.md`. The watcher globs `.voltron/journal/*.md` (not a single fixed
file) and, on the idle-tick, computes "today's" filename from a UTC clock so a
date rollover is picked up without restart. Watching the glob also means a brand
new day-file's first `add` event is handled identically to a `change`.

---

## 3. Hub node live behavior + animation

### 3.1 Hub states

The hub gains a small **orchestrator-liveness state** orthogonal to the
container `statusMachine` states (it is not a container and has no exit code):

| Hub state | Trigger | Visual |
|---|---|---|
| `active` | latest journal append within `hubFreshnessMs` | tier-1 **breathing pulse** (largest amplitude, per redesign §4 line 267), full opacity, label visible |
| `idle` | window lapsed, no recent append, but ≥1 agent still live | **dimmed** (reduced opacity), pulse stops, label fades to a muted "orchestrator idle" |
| *(absent)* | window lapsed **and** zero live agents | hub removed (ephemeral — present-tense rule) |

### 3.2 Hub presence rule (a deliberate change)

Today the hub exists **only while ≥1 agent is live** (`buildLiveEdges` returns
`[]` on an empty set). This feature widens the rule to:

> **Hub present ⟺ (≥1 live agent) OR (orchestrator journal-active).**

This is the crux of the feature: it lets the hub appear while the orchestrator is
working **before/between** dispatches (reading the backlog, decomposing) with no
containers yet running — exactly the near-invisible activity the user asked to
surface. It stays honest to the present-tense/ephemeral rule because the hub is
shown **only while the journal is fresh** and disappears once both the journal
goes stale and the live set empties.

### 3.3 Label

The label is the latest entry rendered as `<kind-icon> <truncated free text>`,
e.g. `→ Dispatched fullstack-dev (B1) to scaffold the repo…`. It is a single
ephemeral line — **not** a scrolling feed. Truncate to ~80 chars for the node
tooltip / hub caption. Kind→icon reuses the journal kinds (🚀 session_start,
→ dispatch, ✅ validation_pass, 📋 session_recap, 📝 note, etc.).

### 3.4 Animation

- **Active pulse.** Reuse the tier-scaled breathing pulse already specified for
  the hub (redesign §4 line 267 — "Tier-1 hub breathes largest"); it is now
  *gated on `active`* rather than always-on.
- **Idle wind-down.** On `active → idle`, ease opacity down and stop the pulse
  (a quiet "the orchestrator paused" cue), distinct from a container's
  `exiting:*` flash so the two never read the same.
- **Dispatch spoke flash (§3.5).** On a `dispatch`-kind journal entry, briefly
  intensify the marching-ants flow on the correlated hub→agent spoke.

### 3.5 Dispatch correlation animation (best-effort, phase-2)

When a `dispatch` journal line is parsed, optionally correlate it to the
container that appears moments later:

1. The `dispatch` entry **primes a pending-dispatch** (timestamp + any agent
   name scanned heuristically from the free text, e.g. "Dispatched
   `fullstack-dev`…").
2. If a matching container `agent:enter` arrives within a **correlation window**
   (~10 s), play a one-shot **launch flash** along that hub→agent spoke (a pulse
   of the existing line-dash flow), reinforcing "the hub just launched this one."
3. If no identifiable agent name is found, fall back to a subtle **hub
   emphasis** pulse instead of guessing a spoke — never flash a false edge.
4. Pending dispatches **expire** silently; correlation is a visual nicety, never
   a state the model depends on.

**Ship order:** the flat active/idle hub (§3.1–§3.4) first; add §3.5 only if it
reads well — mirroring how redesign §3.2 item 4 defers sub-manager attribution.

---

## 4. Minimal journal parsing (reintroduced)

### 4.1 What the deleted parser did (and why it was removed)

The v2 cutover deleted `src/parsers/journal.js`, which produced an **append-only
feed array** — every line accumulated into `journal[]` in the StateModel to drive
a scrolling activity-feed panel and phase swim-lanes. The redesign judged that
"work-tracking noise" (redesign §3.3, §5.1) and gutted it.

### 4.2 What the new minimal parser returns (and how it differs)

The reintroduced `src/parsers/journal.js` is a **single-latest-entry tail**, not a
feed accumulator:

```js
// parseLatestJournalEntry(appendedText, filePath) -> JournalSignal | null
// Scans only the appended bytes; returns the LAST recognizable entry, or null.
{
  ts:    "HH:MM",        // from the line
  kind:  "dispatch",     // one of the 9 journal kinds
  agent: "scrum-master", // line's backtick name (≈ always the orchestrator)
  text:  "Dispatched fullstack-dev (B1) to scaffold the repo…",
  // optional, only when kind === 'dispatch' and a name is confidently scanned:
  dispatchTarget: "fullstack-dev"
}
```

Plus a `tailJournal(filePath, fromOffset)` returning `{ signal, newOffset }`,
exactly paralleling `tailLog` in `src/parsers/logs.js`.

**Differences from the deleted parser — explicit:**

| Deleted feed parser | New minimal signal parser |
|---|---|
| Returned an **array** of all entries (history) | Returns **one** object — the latest entry only |
| Accumulated into `state.journal[]` | State holds a **single** `hub` object; nothing accumulates |
| Drove a scrolling feed + swim-lanes | Drives **one** ephemeral label + a freshness flag |
| Read whole file / re-parsed on change | **Offset-tracked tail**; only new bytes parsed |
| Kept after the orchestrator went quiet | Label **disappears** when the hub goes idle/absent |

The model surface added is one object, e.g.:
```js
hub: { present: bool, state: 'active'|'idle', label: string, kind: string,
       lastTs: string, dispatchTarget?: string }
```
carried by a new `HUB_UPDATE` bus event (or, to minimize surface, an
`AGENT_UPDATE` with `nodeId === HUB_ID` plus a `hub:true` marker — see §6 B3).

---

## 5. Read-only + honesty constraints

- **Read-only discipline (non-negotiable).** The journal is **read only**: stat
  for mtime and read appended bytes via the offset tail. **Never** `fs.write*`,
  `appendFile`, `mkdir`, or `rm` under `.voltron/journal/` (or anywhere in
  `.voltron/` / `.beads/`). The read-only audit in §6 B8 must cover the new
  journal paths.
- **The hub is a host session, not a container.** Keep the existing `.hub` class
  and visually distinguish it from container nodes. Never show it an exit code,
  a container name, or a `working`/`exiting:*` container state — its only states
  are `active`/`idle`, and they are **inferred from journal activity, not
  Docker**.
- **Liveness is inferred, label it so.** "Active" means "journaled within
  `hubFreshnessMs`," which is a proxy for "the orchestrator is busy," not a
  guarantee. Treat a stale journal as **idle/absent**, never as "crashed."
- **Dispatch correlation is inferred and best-effort.** Spoke flashes (§3.5) are
  a heuristic correlation between a journal line and a container appearance; if
  uncertain, do nothing rather than draw a false relationship — consistent with
  redesign §3.3 ("no edges asserting a relationship we cannot prove").
- **Present-tense & ephemeral.** Only the latest entry is ever shown; history is
  never surfaced; the hub and its label vanish when activity stops and no agents
  remain.
- **Degrade gracefully.** Missing/empty journal dir, CRLF line endings, a
  partially-written final line, or a permission error must be tolerated — the
  observer must never crash (mirror the swallow-errors discipline in
  `src/watcher.js`).

---

## 6. Build order (ordered, single-agent-sized tasks)

Each task is small enough for one specialist agent and ends with a concrete
verification. Tasks B1–B6 are the flat MVP; B7 is the optional correlation
nicety; B8 is the gate.

**B1 — Minimal journal parser.**
Add `src/parsers/journal.js` with `parseLatestJournalEntry(text, filePath)` and
`tailJournal(filePath, fromOffset)` returning the single latest `JournalSignal`
(§4.2). Tolerate CRLF and a partial trailing line.
*Verify:* `test/journal.test.js` (node:test) against a fixture journal — asserts
the last entry's `kind`/`text` are returned, that mid-file lines are ignored, and
that a non-matching chunk returns `null`.

**B2 — Journal watcher branch.**
Extend `src/watcher.js` to also watch `.voltron/journal/*.md` (offset-tracked
tail, 120 ms debounce, `add`+`change`), invoking a new `onJournalEvent(signal)`
callback. Seed offsets to current size at startup so history is **not** replayed
(present-tense rule).
*Verify:* unit/integration test — appending one line to a temp journal yields
exactly one `onJournalEvent`; pre-existing content yields none.

**B3 — Hub liveness in the reconciler.**
Add `applyJournalEvent(signal)` to `src/liveness.js`: record `lastJournalTs`,
set hub `state='active'`, store the label/kind, and (re)arm the idle-tick that
flips `active → idle` after `hubFreshnessMs` (injectable `timer`/fake clock).
Add a `HUB_UPDATE` event to `src/eventBus.js`. Update the **hub-presence rule**
(§3.2): emit the hub when journal-active **or** ≥1 agent live; have
`buildLiveEdges`/`recomputeEdges` keep the hub while active even with an empty
live set.
*Verify:* `test/liveness.test.js` — scripted journal events + fake clock assert
`active` on append and `idle` after the window; hub present with zero agents while
active; hub gone when stale **and** empty.

**B4 — StateModel hub field.**
Hold a single `hub` object in `src/state.js`; handle `HUB_UPDATE` in
`applyEvent`; include `hub` in `snapshot()`. No arrays/history.
*Verify:* unit test — applying a `HUB_UPDATE` then `snapshot()` returns the hub
object; an idle update mutates it in place (no accumulation).

**B5 — CLI wiring + idle tick + UTC rollover.**
In `bin/cli.js`, wire the watcher's `onJournalEvent → reconciler.applyJournalEvent`;
add the idle-tick (reuse `--poll`, or a dedicated cadence) that re-evaluates hub
freshness; add `--hub-freshness <ms>` (default 60000); resolve "today's" journal
filename from a UTC clock so midnight rollover is handled without restart.
*Verify:* boot smoke — `node bin/cli.js --root .` serves on 127.0.0.1; manually
appending a line to today's journal flips the hub to `active` in the WS snapshot,
then to `idle` after the window.

**B6 — Frontend hub enrichment.**
In `public/app.js` / `public/cytoscape-style.js` / `public/styles.css`: consume
the `hub` snapshot/patch; render the latest-entry label on the hub; apply
`active` (gated breathing pulse) vs `idle` (dimmed, no pulse) classes; create the
hub when journal-active even with zero agents; remove it when idle **and** empty.
*Verify:* `node --check public/app.js`; manual — hub appears/pulses on journal
activity, dims when quiet, label matches the last journal line; no console errors.

**B7 — (Optional, phase-2) Dispatch-spoke correlation flash.**
Prime a pending-dispatch on a `dispatch`-kind signal; on a matching container
`agent:enter` within ~10 s, emit a one-shot spoke-flash hint the frontend renders
as a launch pulse on that hub→agent edge; expire pending dispatches silently;
fall back to a hub emphasis pulse when no agent name is confidently scanned.
*Verify:* reconciler unit test — a dispatch signal followed by a correlated
`agent:enter` produces one flash hint; an uncorrelated dispatch expires with
none. Manual: spoke flashes on real dispatch, never a false edge.

**B8 — Read-only audit + docs.**
Re-run the read-only-discipline audit extended to the journal paths (`grep` for
`fs.write*`/`appendFile`/`mkdir`/`rm` touching `.voltron/journal` → must be
zero); confirm only reads/stats occur; document `--hub-freshness` and the
inferred-liveness honesty notes in the README/CLAUDE.md.
*Verify:* audit grep returns zero write calls under `.voltron`; full `npm test`
green; README documents the new flag and the host-session/inferred-liveness
caveat.

---

## 7. Open questions (need human input before B5/B7)

1. **Freshness window value.** Is `60 s` the right default, or should it adapt
   (e.g. widen during `session_start`/decompose phases)? Affects how "twitchy"
   the idle transition feels.
2. **Hub-with-zero-agents (B3 presence-rule change).** Confirm the orchestrator
   hub *should* appear before the first container — it is the feature's point,
   but it is a visible behavior change from redesign §3.2. (Recommended: yes.)
3. **Event surface.** New `HUB_UPDATE` event vs overloading `AGENT_UPDATE` with
   `nodeId === HUB_ID`. (Recommended: a dedicated `HUB_UPDATE` — cleaner state
   handling, no risk of the hub being mistaken for a container entry.)
4. **Ship B7 now or defer?** Correlation is a nicety; the flat hub may be enough
   for v1.

---

*Design saved to `docs/scrum-master-monitor-design.md`. Invoke `/scrum-master`
to decompose §6 (Build Order) into agent tasks.*
