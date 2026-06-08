# voltron-glimpse

Real-time, read-only graph dashboard for Project Voltron agent runs. Run it at the root of
any Voltron project and a browser opens to a live visualization: one node per dispatched
agent, color-coded by status, sized by tier, wired by dispatch and dependency edges, grouped
into phase swim-lanes, with a scrolling journal feed and click-through detail panels. Glimpse
is strictly an observer — it never writes to `.voltron/` or `.beads/`, never modifies
Voltron templates, and only serves on `127.0.0.1`.

---

## Install

**Node 20 LTS or newer required.**

```bash
npm i -g voltron-glimpse
```

Or run without installing:

```bash
npx voltron-glimpse
```

---

## Usage

Run `voltron-glimpse` at the root of any Voltron project (or anywhere inside one).
It walks up the directory tree to find the nearest ancestor that contains a `.voltron/`
directory, then starts the dashboard and opens a browser tab automatically.

```bash
cd /path/to/your-voltron-project
voltron-glimpse
# → voltron-glimpse  →  http://127.0.0.1:7424
# → watching /path/to/your-voltron-project/.voltron (read-only)
```

The process runs in the foreground. Press **Ctrl-C** to stop.

---

## Flags

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `7424` | Port to bind the HTTP + WS server. If the port is in use, Glimpse auto-increments until it finds a free one (up to +50). |
| `--no-open` | *(browser opens)* | Skip auto-launching the browser. Print the URL instead. |
| `--root <path>` | *(auto-detect)* | Override project root detection. Pass the directory that contains `.voltron/`. |
| `--docker` | `false` | Enable live Docker container introspection via `docker ps`. Off by default. See [Limitations](#limitations). |
| `--verbose` | `false` | Print the resolved project root, public directory, and other startup details to stdout. |
| `-h`, `--help` | | Print the help text and exit. |

---

## What it shows

**Graph canvas (center)**
- One node per dispatched agent instance (each log file = one dispatch = one node).
- **Status colors:** grey = queued · blue = dispatching · green + pulse = working · solid
  green = done · orange = blocked · red = errored/failed.
- **Node size:** Tier 1 orchestrators are largest, Tier 2 sub-managers medium, Tier 3
  micro-agents smallest.
- **Phase swim-lanes:** nodes grouped horizontally by their `progress.json` phase string.
  Tasks with no phase appear in an "Unphased" lane.
- **Dispatch edges (dashed, inferred):** a star from the orchestrator to each dispatched
  agent. Animated ripple while the target is working. These edges are *inferred* from
  timing — see [Limitations](#limitations).
- **Dependency edges (solid, declared):** from `bd list --json` dependency records. These
  reflect actual bead task-ordering constraints.

**Left sidebar — live journal feed**
- Scrolling activity stream from `.voltron/journal/*.md`, newest entries at top.
- Each entry shows time (`HH:MM`), an emoji for the event kind, agent name, and text.
- Filter by agent (multi-select chips) or by phase.

**Bottom panel — status & phases**
- Live tallies: queued / dispatching / working / done / blocked / failed.
- Per-phase progress bars (done vs total tasks in that phase).
- "Active now" strip showing currently-working agents and their latest step.

**Node click → detail modal**
- Log tail (last 50 lines of that agent's `.log` file).
- Prompt metadata: container name, dispatch time, exit time, exit code. If the prompt file
  in `.voltron/tmp/` is still present (live dispatch), its content is shown; otherwise
  "prompt not retained" (Voltron deletes prompt files immediately after dispatch).
- Container info: name from log filename; live status only if `--docker` is enabled.

**Analysis indicator**
- When an `analyses/*.md` report exists, an indicator appears on the related node (or top
  bar). Clicking it renders the full analysis markdown in a modal.

---

## Limitations

These are honest constraints, not roadmap items. Design decisions made to accommodate them
are documented in `docs/implementation-plan.md §3`.

1. **Strictly read-only.** Glimpse never writes, appends, or deletes any file under
   `.voltron/` or `.beads/`. It will not modify Voltron templates or aggregated state.

2. **Dispatch edges are inferred, not declared.** Voltron does not record parent/child
   dispatch relationships to disk. Dashed edges are *inferred* from timing (which agent
   started the run, batch-dispatch windows). Solid edges are *declared* bead dependencies
   read from `bd list --json`. A legend in the dashboard distinguishes the two. Do not treat
   inferred edges as authoritative.

3. **The tier map is a baked-in snapshot.** Agent tiers (Tier 1 / 2 / 3) are not stored on
   disk by Voltron. Glimpse ships a frozen copy of the tier tables from Voltron's templates.
   Unknown agents default to Tier 3. If Voltron adds new agents between Glimpse releases,
   they will render at Tier 3 size until the snapshot is refreshed.

4. **Beads / Dolt features degrade gracefully.** Beads uses a Dolt database, not a flat
   file. Glimpse watches `.beads/interactions.jsonl` as a change signal and re-runs
   `bd list --json` on each change. If `bd` is not on PATH, or if the Dolt server is down
   (common on Windows after reboot), dependency edges are simply absent. All other features
   — dispatch edges, status colors, journal feed — continue working.

5. **Localhost-only; no auth, no remote exposure.** The HTTP server and WebSocket server
   bind to `127.0.0.1` only. There is no TLS, no authentication, and no intent to expose
   the dashboard remotely. Do not run behind a reverse proxy that forwards external traffic.

6. **No history beyond what `.voltron/` holds.** Glimpse reads the on-disk run artifacts as
   they exist. It does not persist its own history database. Restarting Glimpse re-reads the
   same files from scratch.

7. **Live Docker introspection is opt-in (`--docker`).** Without `--docker`, "done/failed"
   status comes from `[exit] code=` in the log file. With `--docker`, Glimpse additionally
   queries `docker ps` for live container status. This is off by default to keep Glimpse
   file-based and read-only by default.

8. **Step labels are best-effort.** Many agents (e.g. `committer`) never emit `[STEP N]`
   lines. Node labels fall back to phase/status when no step is present.

---

## Contributing

This project follows the Voltron Glimpse implementation plan in `docs/implementation-plan.md`.
The code is CommonJS Node.js with no build step. Vendored frontend libraries live in
`public/vendor/`. Run tests with:

```bash
npm test
```
