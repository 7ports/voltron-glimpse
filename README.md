# voltron-glimpse

Real-time, read-only visualization of the Voltron agents whose Docker containers are
**currently running**, and the (inferred) dispatch connections between them. Run it at
the root of any Voltron project and a browser opens to a live animated graph: one node
per running container, pulsing while active, exiting when the container stops. Glimpse
is strictly an observer — it never writes to `.voltron/` or `.beads/`, and only serves
on `127.0.0.1`.

---

## Install

**Node 20 LTS or newer required. Docker must be available on the host for primary mode.**

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
directory, then starts the monitor and opens a browser tab automatically.

```bash
cd /path/to/your-voltron-project
voltron-glimpse
# → voltron-glimpse  →  http://127.0.0.1:7424
# → watching /path/to/your-voltron-project/.voltron/logs (read-only)
```

Glimpse queries the host Docker daemon every second for containers named `voltron-*`.
When an agent's container starts, a node appears and animates in; while it runs it
pulses; when the container exits, the node winds down and disappears. An empty canvas
when nothing is running is the correct behavior, not a bug.

The process runs in the foreground. Press **Ctrl-C** to stop.

---

## Flags

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `7424` | Port to bind the HTTP + WS server. If the port is in use, Glimpse auto-increments until it finds a free one (up to +50). |
| `--no-open` | *(browser opens)* | Skip auto-launching the browser. Print the URL instead. |
| `--root <path>` | *(auto-detect)* | Override project root detection. Pass the directory that contains `.voltron/`. |
| `--docker` | `on` | Use Docker daemon introspection for liveness (the primary mode, on by default). |
| `--no-docker` | | Skip Docker; infer liveness from log-file freshness instead. **Degraded mode** — a stalled-but-alive container with no log output may be missed. A "Docker unavailable" badge appears in the UI. |
| `--poll <ms>` | `1000` | Docker poll cadence in milliseconds. |
| `--verbose` | `false` | Print the resolved project root, public directory, and liveness mode to stdout. |
| `-h`, `--help` | | Print the help text and exit. |

---

## What it shows

**Graph canvas (full screen)**
- One node per currently-running `voltron-*` Docker container.
- **Live states:** dim blue = dispatching (container up, not yet exec'd) · **vivid green + pulse = working** · bright green flash → fade = just finished (clean) · red flash → fade = just finished (error).
- **Node size:** Tier 1 orchestrators largest, Tier 2 sub-managers medium, Tier 3 micro-agents smallest.
- **Dispatch edges (dashed, inferred):** a spoke from the synthetic `scrum-master` hub to each live agent. Animated marching-ants while the target is working. These edges are *inferred* from timing — parentage is not recorded on disk. A legend in the dashboard labels them "inferred dispatch."
- **Animations:** nodes entrance-ripple on arrival, breathe while working (phase-jittered per node), and wind down with a terminal flash on exit (~2.5 s linger so you perceive the finish).
- **Docker availability badge:** shows whether Docker introspection is active or whether Glimpse has fallen back to log-freshness mode.

**Node hover/click — minimal detail card**
- Agent name, container name, dispatch time.
- Current `[STEP N]` / `[DONE]` label from the log tail (best-effort).
- Exit code if the node is in wind-down.

---

## Limitations

These are honest constraints, not roadmap items.

1. **Strictly read-only.** Glimpse never writes, appends, or deletes any file under
   `.voltron/` or `.beads/`. It queries `docker ps` (read) and tails log files (read). It
   will not modify Voltron templates or aggregated state.

2. **Only currently-running agents are shown.** Glimpse is present-tense and ephemeral —
   it shows what is live *right now*, not history. Agents that have already finished are
   not shown, even if their log files remain on disk.

3. **Dispatch edges are inferred, not declared.** Voltron does not record parent/child
   dispatch relationships to disk. All edges are inferred from timing and drawn as dashed
   lines labeled "inferred." Do not treat them as authoritative.

4. **The tier map is a baked-in snapshot.** Agent tiers are not stored on disk by Voltron.
   Glimpse ships a frozen copy of the tier table. Unknown agents default to Tier 3 until
   the snapshot is refreshed.

5. **`--no-docker` mode is approximate.** Without Docker, liveness is inferred from
   log-file modification time. A stalled-but-alive container with no log output may be
   missed; a crashed container with no `[exit]` line may linger until the freshness window
   expires. The UI shows a clear badge when operating in this degraded mode.

6. **Localhost-only; no auth, no remote exposure.** HTTP and WebSocket servers bind to
   `127.0.0.1` only. There is no TLS, no authentication, and no intent to expose the
   monitor remotely.

7. **Step labels are best-effort.** Many micro-agents never emit `[STEP N]` lines. Node
   labels fall back to the agent name + "running" when no step is present.

---

## Contributing

This project follows the redesign spec in `docs/live-monitor-redesign.md`. The code is
CommonJS Node.js with no build step. Vendored frontend libraries live in `public/vendor/`.
Run tests with:

```bash
npm test
```
