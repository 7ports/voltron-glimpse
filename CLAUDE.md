# CLAUDE.md — Web Project Context

> This file is automatically loaded by Claude Code at session start.
> Keep it up to date as your project evolves. Agents read this before acting.

## Mandatory Dependencies

Voltron's three-tier agent model relies on three external tools. Setup/scaffold accounts for all of them; if any is missing, run the install command before invoking agents.

| Tool | Purpose | Install (cross-platform) | Alternative |
|---|---|---|---|
| **beads** ([gastownhall/beads](https://github.com/gastownhall/beads)) | Dependency-aware task tracking — drives the bead graph that scrum-master uses to enforce task ordering. | `npm install -g @beads/bd` | `brew install beads` (macOS / Linux) |
| **stringer** ([davetashner/stringer](https://github.com/davetashner/stringer)) | Codebase baseline analysis — read by code-analyst before every audit. | `go install github.com/davetashner/stringer/cmd/stringer@latest` (needs Go) | Pre-built binary from [releases](https://github.com/davetashner/stringer/releases/latest), or `brew install davetashner/tap/stringer` (macOS) |
| **alexandria** ([7ports/project-alexandria](https://github.com/7ports/project-alexandria)) | Tooling/setup guides — every agent calls `mcp__alexandria__quick_setup` before installing any tool, and `update_guide` after. | `git clone` + `npm install` in `mcp-server/` + register MCP server in `~/.claude.json` | (none — required setup) |

Verify all three by running `mcp__project-voltron__setup_voltron` — it hard-fails with install commands if any are missing.

---

---

## Project Identity

**Project Name:** Voltron Glimpse
**Type:** Standalone Node CLI + localhost web dashboard (read-only observer)
**Tech Stack:** Node.js (vanilla JS, no build step) · `chokidar` · `ws` · `open` · Cytoscape.js + cytoscape-dagre (vendored, offline) on the frontend
**Node Version:** 20 LTS
**Package Manager:** npm
**Status:** Prototype (greenfield — being implemented from `docs/` plan)

**What it is:** A real-time, read-only visualizer companion for Project Voltron. Run `voltron-glimpse` at the root of any Voltron project → it auto-detects the project root (nearest ancestor with `.voltron/`), watches on-disk run artifacts, and serves a live graph dashboard on `127.0.0.1`: one node per dispatched agent, color-coded by status, sized by tier, wired by inferred dispatch + declared bead-dependency edges, grouped into phase swim-lanes, with a live journal feed and drill-down panels.

**Hard constraints (non-negotiable):** strictly an observer — NEVER writes any path under `.voltron/` or `.beads/`; no Voltron template changes; no multi-project aggregation; no history beyond what `.voltron/` holds; no auth/encryption/remote exposure (bind HTTP + WS to `127.0.0.1` only). The full implementation plan lives in `docs/implementation-plan.md`.

---

## Repository Layout

```
bin/
  cli.js              <- arg parse, root detection, wire watcher→bus→state→servers, open browser
src/
  projectRoot.js      <- resolveProjectRoot(startDir): walk up to find .voltron/
  watcher.js          <- chokidar setup; emits raw {kind,file} → normalizers
  eventBus.js         <- tiny EventEmitter wrapper + event-name constants
  state.js            <- StateModel: apply normalized events, expose snapshot()
  transport/
    wsServer.js       <- ws server, snapshot-on-connect, broadcast(patch)
    httpServer.js     <- static file server for public/
  parsers/
    progress.js       <- progress.json → agent/phase/status/counts events
    journal.js        <- journal/*.md tail → journal:append events
    logs.js           <- logs/*.log tail → agent lifecycle/step/exit events
    analyses.js       <- analyses/*.md → analysis:add (metadata) + lazy markdown read
    beads.js          <- interactions.jsonl change → debounce → `bd list --json` → edges/deps
  model/
    tiers.js          <- baked-in agent→tier map + getTier(name) default 3
    statusMachine.js  <- derive node visual-state from progress + log signals
    edges.js          <- build star + batch-group + beads-dep edges
public/               <- build-free frontend: index.html, app.js, cytoscape-style.js, styles.css
  vendor/             <- cytoscape.min.js, cytoscape-dagre.min.js, dagre.min.js (bundled, offline)
test/
  parsers.test.js     <- fixture-driven parser unit tests (node:test)
  fixtures/           <- real samples copied read-only from project-voltron/.voltron/
docs/
  implementation-plan.md  <- the full plan this project implements
```

**Rule:** Keep file parsing decoupled from transport via the StateModel + EventBus. Parsers normalize raw fs events into domain events; the StateModel is the single in-memory source of truth; transport just snapshots/broadcasts. No business logic in transport.

---

## Code Conventions

**JavaScript (no TypeScript, no build step):**
- Plain Node.js ESM/CJS — pick one and stay consistent (CommonJS `require` is fine for a zero-build CLI)
- Named exports over default exports
- Use `path` for ALL path handling (host is Windows); tolerate CRLF in journal/log parsing
- Small, single-responsibility modules matching the layout above

**Frontend (vanilla JS, vendored libs):**
- No React, no bundler, no build step — vendored Cytoscape in `public/vendor/`, offline-capable
- Status colors as CSS classes toggled on Cytoscape nodes; `working` adds a pulse animation
- WS client gets a full `snapshot` on connect, then small `patch` deltas; auto-reconnect with backoff

**Backend / read-only discipline:**
- Servers bind to `127.0.0.1` ONLY — never `0.0.0.0`
- NEVER call `fs.write*`/`appendFile`/`mkdir`/`rm` against any path under `.voltron/` or `.beads/`
- Shell out to `bd list --json` (cwd = project root) only as a read; degrade gracefully if `bd` is absent
- Debounce watchers; tail logs by tracking file offsets, don't re-parse whole files on each change

---

## Key Packages & Versions

| Package | Version | Notes |
|---|---|---|
| [Framework] | [x.x.x] | |
| [Build tool] | [x.x.x] | |
| [Your other packages] | | |

---

## Environment Variables

| Variable | Where | Secret? | Description |
|---|---|---|---|
| [VAR_NAME] | [.env / CI secret] | [Yes/No] | [What it's for] |

**Rule:** Never commit `.env` files. Always provide `.env.example` with placeholder values.

---

## Verification Commands

```bash
# Type checking
npm run typecheck          # or: npx tsc --noEmit

# Linting
npm run lint               # ESLint + Prettier check

# Tests
npm test                   # Unit tests
npm run test:e2e           # E2E tests (if configured)

# Build
npm run build              # Production build

# Dev server
npm run dev                # Frontend dev server
npm run dev:server         # Backend dev server (if applicable)
```

**Definition of done for any task:**
1. No TypeScript errors (`tsc --noEmit` passes)
2. Linting passes (`eslint` clean)
3. All existing tests pass
4. New code has tests where appropriate
5. Bundle size checked (no unexpected growth)
6. Changes committed to git with a descriptive message

---

## Active Work

<!-- Update this section frequently — agents use it to understand current focus -->

**Current sprint goal:** Implement Voltron Glimpse from `docs/implementation-plan.md` (see §9 Build Order).

**In progress:**
- [ ] Build Order step 1 — repo scaffold (git init ✓, Voltron agents ✓; still TODO: package.json + bin, README, LICENSE, install deps, vendor Cytoscape + dagre)

**Recently completed:**
- [x] Scaffolded Voltron fullstack agent team + git init on `main`

**Known issues / tech debt:**
- Beads is a Dolt DB, not a flat file — watch `.beads/interactions.jsonl` as a change signal, then re-poll `bd list --json`. Degrade gracefully when `bd`/Dolt is down (common on Windows after reboot).
- Dispatch parent/child is NOT recorded on disk — dispatch edges are *inferred* (dashed); only bead deps are *declared* (solid). Be visually honest about the distinction.
- Tiers are NOT on disk — ship a baked-in tier map, default unknown agents to Tier 3.

---

## Agent Team Roles

### Orchestrator (slash command — runs in the main Claude Code session)

| Command | File | Purpose |
|---|---|---|
| `/scrum-master` | `.claude/commands/scrum-master.md` | Work breakdown, task assignment, sprint coordination, dispatch to specialists |

**Why a slash command, not a subagent:** the scrum-master must run in your main chat session so it can stream real-time agent output and channel communication between you and the specialist agents. Subagent contexts cannot do any of that. Always invoke with `/scrum-master`.

### Specialist subagents (defined in `.claude/agents/`)

| Agent | File | Purpose |
|---|---|---|
| `project-planner` | `project-planner.md` | Tech stack research, architecture design, project planning |
| `fullstack-dev` | `fullstack-dev.md` | React/TS frontend + Node.js/Express backend |
| `devops-engineer` | `devops-engineer.md` | Terraform, CI/CD, deployment, cloud infrastructure |
| `ui-designer` | `ui-designer.md` | CSS, responsive layout, theming, PWA, accessibility |
| `qa-tester` | `qa-tester.md` | Testing, audits, bundle analysis, quality gates |

**Invoke specialists with:** `@agent-project-planner`, `@agent-fullstack-dev`, `@agent-devops-engineer`, etc. (Note: `/scrum-master` will dispatch these for you — you rarely need to invoke them directly.)

---

## Docker Execution

The scrum-master launches specialist agents inside Docker containers automatically via the `run_agent_in_docker` MCP tool. Each agent runs with `--dangerously-skip-permissions` for fully autonomous execution — no manual approval prompts. **This is the primary dispatch path for all web/fullstack work.**

**Prerequisites:**
- Docker must be installed and running
- `Dockerfile.voltron` must exist in the project root (generated by `scaffold_project`)

You do not need to change how you start Claude Code. Run it normally on your desktop — Docker is handled behind the scenes when agents are invoked.

> **Note (Unity-only Editor exception):** Voltron Unity projects have a narrow exception where four Editor-bound managers (`scene-architect`, `build-validator`, plus Editor-preview slices of `shader-artist`/`asset-manager`) are dispatched via the `Agent` tool because they need a live Unity Editor with Coplay MCP. Web/fullstack projects have no such exception — every agent here goes through `run_agent_in_docker`.

---

## MCP Tools Available

- **git** — version control operations
- **github** — PR/issue management
- **memory** — persist decisions and patterns across sessions
- **fetch** — API docs, package changelogs, references
- **alexandria** — tooling setup guides; **mandatory** — call `quick_setup` before installing any tool (no exceptions), `update_guide` after. Alexandria is for non-project-specific documentation only (tool setup, platform quirks, version notes) — project-specific knowledge stays in CLAUDE.md

---

## Important Project Decisions

<!-- Use this as a living log — add entries as decisions are made -->

| Date | Decision | Reason |
|---|---|---|
| [YYYY-MM-DD] | [e.g. "SSE over WebSocket for client relay"] | [e.g. "One-directional data, auto-reconnect, no library needed"] |

---

## Agent Auto-Update

Voltron agents are kept current automatically. At the start of each session:
1. Agents will be auto-updated if the installed version differs from the local Voltron installation
2. If you see `[VOLTRON] Updated N agent(s)` in your context, acknowledge the update to the user

---

## Session Closeout Protocol

At the end of each working session, submit a reflection to help Project Voltron improve its agent templates:

```
mcp__project-voltron__submit_reflection({
  project_name: "[this project's name]",
  project_type: "web",
  session_summary: "[what was accomplished]",
  agents_used: ["list", "of", "agents", "invoked"],
  agent_feedback: [{ agent: "...", needs_improvement: "...", suggested_change: "..." }],
  overall_notes: "..."
})
```

Even a brief reflection is valuable. Focus on gaps in agent instructions that required workarounds.

If the session included any tool setup, API integration, or platform-specific discoveries, call `mcp__alexandria__update_guide` to record findings. Record only non-project-specific knowledge — tool setup steps, platform gotchas, version compatibility. Never record project-specific content (business logic, custom architecture, project configs) in Alexandria; that belongs in CLAUDE.md.

---

## Trello (Optional)

> Fill in if this project has a Trello board. When configured, the scrum-master can pull cards directly as backlog tasks.

```
TRELLO_BOARD_ID=          # from board URL: trello.com/b/<BOARD_ID>/...
```

Credentials (`TRELLO_API_KEY`, `TRELLO_TOKEN`) live in your shell environment or `.env` (gitignored). Get them at https://trello.com/power-ups/admin.

**Dev server URL for visual verification:** http://localhost:PORT  ← update with your actual port

---

## Things Claude Should Never Do

- Commit `.env`, API keys, secrets, or credentials
- Push directly to `main` — always use feature branches + PRs
- Install packages without checking bundle size impact
- Use `any` type in TypeScript
- Skip error handling on API routes or async operations
- Hardcode URLs, ports, or environment-specific values
- Modify `node_modules/` or lock files manually