# Voltron Glimpse — Pod Distinction Design

> **Status:** Design / research only — no implementation in this document.
> **Extends:** `docs/live-monitor-redesign.md` §2 (liveness via `docker ps`) and
> §3 (synthetic hub + inferred spokes), and `docs/scrum-master-monitor-design.md`
> (the journal-driven hub). This feature adds a **pod dimension** to the existing
> live set: every discovered container is attributed to the Voltron project/
> session that launched it, and the view scopes to — or visually separates — those
> pods.
> **Audience:** `/scrum-master`, which decomposes §6 into agent-sized tasks.

---

## 1. Problem + intent

### 1.1 The gap (user-reported)

Glimpse discovers running agents by shelling out to:

```
docker ps --no-trunc --filter name=voltron- --format '{{.ID}}\t{{.Names}}\t…'
```

(`src/docker.js`). The `name=voltron-` filter matches **every** Voltron container
on the host Docker daemon — regardless of which Claude Code session or which
project root launched it. The container name is
`voltron-<agent>-<ISO-ts>-<suffix>` (`docs/live-monitor-redesign.md` §2.1); it
encodes the **agent** and a **dispatch timestamp** but carries **no project or
session identity**.

Consequently, if a user has two or more Voltron projects (or two Claude Code
sessions on the same project) dispatching containers at once, Glimpse renders
them **all mixed into one graph**, all hanging off a single synthetic
`scrum-master` hub (`src/model/edges.js`). There is no way to tell which "pod"
(project/session grouping) a given node belongs to, and the single hub
**falsely implies one orchestrator dispatched all of them**.

### 1.2 Definition: "pod"

A **pod** is the set of containers launched by one Voltron project root —
i.e. all containers that bind-mount the **same host workspace path** to
`/workspace`. The project root *is* the pod identity (see §2). The pod's
human-facing label is the **basename** of that root path (e.g.
`voltron-glimpse`, `acme-store`).

> **Pod ≈ project, not strictly session.** Two Claude Code sessions on the *same*
> project root produce containers with the *same* mount source, so they collapse
> into one pod. Distinguishing two sessions on the *same* root is **not reliably
> possible from disk** (see §2.4) and is an explicit non-goal for v1.

### 1.3 Intent

1. **Attribute** every live container to its pod using a host-only, read-only
   signal.
2. **Scope** the view to the launching project's pod by **default** (the common
   case: one user, one project, wants to watch *their* swarm), while offering a
   flag to **show and visually separate all pods** for power users running
   several projects at once.
3. Stay inside the live-monitor intent — **present-tense, ephemeral, read-only,
   animated** — and stay **visually honest**: pod membership is *real* (derived
   from the mount source), unlike dispatch parentage which is *inferred*.

### 1.4 Non-goals

- No multi-project **aggregation/history** (the hard constraint in CLAUDE.md
  still holds — we observe whatever is running now, we do not persist a
  cross-project ledger).
- No per-**session** disambiguation within one project root (§2.4).
- No writes anywhere; `docker inspect` is read-only (§5).

---

## 2. Pod-identity mechanism

### 2.1 Signals available on the host

| Candidate signal | How obtained | Carries project identity? | Verdict |
|---|---|---|---|
| **Workspace bind-mount source** | `docker inspect <id> --format '{{json .Mounts}}'` → the mount whose `Destination` is `/workspace`; its `Source` is the host project-root path | **Yes — uniquely.** `scripts/voltron-run.sh` mounts `-v "$(pwd):/workspace"`, so the mount **Source == launching project root** | **Chosen primary** |
| Docker **labels** | `docker inspect … {{json .Config.Labels}}` / `docker ps --filter label=…` | Only if the launcher sets one — **it does not today** (see §2.3) | Preferred *future* signal; not available now |
| Docker **env** (`-e`) | `docker inspect … {{json .Config.Env}}` | `voltron-run.sh` passes only auth/GH tokens, no project/session var | Not usable today |
| Container **name** | already in `docker ps` | **No** — encodes agent + ISO ts only | Insufficient (the whole problem) |
| Container **CreatedAt / batch window** | already in `docker ps` | No — timing is not identity (two projects can dispatch simultaneously) | Insufficient |

### 2.2 Chosen signal: the `/workspace` bind-mount source

The Voltron launch convention (`scripts/voltron-run.sh:49`) mounts the launching
project root at `/workspace`:

```bash
docker run --rm -it … -v "$(pwd):/workspace" … voltron-agent …
```

The MCP `run_agent_in_docker` path that spawns the `voltron-<agent>-…`
specialist containers follows the same convention (the agent must see the project
at `/workspace`). Therefore, for any container, the **host source path of the
mount whose destination is `/workspace`** is the **launching project root** — a
stable, unique pod key.

**How Glimpse reads it (read-only):**

```
docker inspect <id> --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}'
```

- `inspect` is a **pure read** (never `run`/`stop`/`exec`/`create`), consistent
  with the read-only discipline in CLAUDE.md and redesign §1.2.
- The returned `Source` is normalized (via `path`) into:
  - `podRoot` — the absolute host path (the canonical pod key), and
  - `podLabel` — `path.basename(podRoot)` (the display name).
- A short, stable `podId` is derived from `podRoot` (e.g. a hash, or just the
  normalized path used as a Map key). Color is assigned from `podId` (§4.2).

**Windows path note.** The host is Windows; mount sources may surface as
`C:\Users\…\project` or as a Docker-translated `/c/Users/…` / `//host_mnt/c/…`
form. Normalize case-insensitively and tolerate both separators when comparing a
container's `podRoot` to the CLI's own resolved root (which comes from
`resolveProjectRoot`, `src/projectRoot.js`). Comparison is **path-equality after
normalization**, not raw string equality.

### 2.3 Does the launcher set a label or env today?

**No.** Reviewed `scripts/voltron-run.sh`: it sets auth env (`CLAUDE_CODE_*`,
`ANTHROPIC_API_KEY`), GitHub token env, and three bind mounts (workspace, creds,
gitconfig). It sets **no `--label` and no project/session env var**. The MCP
`run_agent_in_docker` launcher is external to this repo and cannot be modified
(hard constraint: "no Voltron template changes"). So **labels are not an
available signal today** — the mount source is the only reliable one.

> **Forward-compatible note (no action here):** if Voltron ever adds a
> `--label com.voltron.project=<root>` / `com.voltron.session=<id>` to the
> launcher, Glimpse should prefer it (one cheap `docker ps --filter label`
> instead of per-container `inspect`, and it would unlock true session-level
> pods). Design the pod resolver behind a small interface so a label-based
> resolver can replace the inspect-based one without touching the reconciler.

### 2.4 Why session-level pods are not feasible from disk

A pod = project root because that is what the mount reveals. Two **separate Claude
Code sessions on the same project root** mount the **same** source, so their
containers are indistinguishable by mount. Nothing the launcher writes to disk or
to the container config records *which session* dispatched a container. Inferring
it from `.voltron/journal/*.md` timing would be a guess that violates the honesty
rule (redesign §3.3). **Decision:** pod == project root; document that
same-root/multi-session collapses into one pod. (If a future launcher adds a
session label, revisit.)

### 2.5 Cost control: inspect once per container, cache by id

`docker inspect` is an **extra** child process beyond the 1 s `docker ps` poll.
To keep the poll cheap (redesign §4.6: `docker ps` every 1000 ms):

- Maintain a module-level **`podCache: Map<containerId, { podRoot, podLabel,
  podId }>`** in `src/docker.js` (or a small `src/pods.js`).
- On each poll, **diff** the returned container ids against the cache. For each
  **newly-seen** id only, run **one** `docker inspect`. Container ids are
  immutable for a container's lifetime and mounts never change after `run`, so a
  pod attribution is computed **exactly once per container**, then reused for
  every subsequent poll.
- **Evict** cache entries for ids no longer present (after the reconciler's
  wind-down linger removes them) to bound memory.
- **Batch** the new-id inspects: a single
  `docker inspect <id1> <id2> … --format '{{.Id}}\t{{range .Mounts}}…'` call
  resolves all newcomers in one child process (Docker accepts multiple ids).
  Typical steady state = **zero** inspects per poll (all ids cached); a dispatch
  burst = one batched inspect.
- **Failure tolerance:** if an `inspect` fails (race: container exited between
  `ps` and `inspect`, daemon hiccup), attribute the container to a sentinel pod
  `unknown` and **retry once** on the next poll; never throw — mirror the
  swallow-errors discipline of `pollDocker` (`src/docker.js`).

### 2.6 Output shape (additive to the existing row)

`pollDocker` rows (`src/docker.js`) gain three fields; everything else is
unchanged so the reconciler and StateModel stay backward-compatible:

```js
{
  id, name, nodeId, agent, createdAt, state, status, // existing
  podId,     // stable key derived from podRoot (Map/color key)
  podRoot,   // normalized absolute host path (canonical identity)
  podLabel,  // path.basename(podRoot) — display name
}
```

`podRoot === null` / `podLabel === 'unknown'` when inspection failed.

---

## 3. Default behavior + flag surface

### 3.1 Decision: **scope to the current pod by default**

Glimpse already runs with a known root — `resolveProjectRoot(startDir)`
(`src/projectRoot.js`) walks up to the `.voltron/` that owns the cwd. Call this
the **self pod** (`selfPodRoot`). The default behavior:

> **By default, show only containers whose `podRoot` path-equals the CLI's own
> `selfPodRoot`.** Other projects' containers are filtered out before they ever
> reach the reconciler.

**Rationale:**

- The overwhelmingly common case is *one user watching their own project's
  swarm*. Showing other projects' containers is the **bug** the user reported;
  scoping is the most direct fix.
- It keeps the single-hub model (`src/model/edges.js`) **honest** — with one pod
  there is exactly one orchestrator, so one hub is correct.
- It respects the existing "no multi-project aggregation" hard constraint as the
  *default*, treating cross-pod viewing as an explicit opt-in.
- It is the cheapest path: scoped-out containers can even skip `inspect` after
  the first poll once their id is cached as "not self pod."

### 3.2 Flag surface

| Flag | Default | Behavior |
|---|---|---|
| *(none)* | — | **Scope to self pod.** Only containers whose `podRoot` == `selfPodRoot` are shown. One hub. (§4.1) |
| `--all-pods` | off | **Show every pod**, visually grouped + colored per pod, one hub per pod. (§4.2–§4.4) Surfaces a pod legend. |
| `--pod <label\|path>` | — | **Scope to a specific pod** other than (or in addition to self), by basename or absolute path. Repeatable: `--pod a --pod b` shows exactly those pods (implies grouped rendering, like `--all-pods` but filtered). |

Notes:
- `--all-pods` and `--pod` are mutually informative: `--pod` is an explicit
  allow-list; `--all-pods` is "everything." If both are given, `--pod` wins
  (explicit filter).
- The self-pod label is always resolvable for the badge even in `--all-pods`
  mode (so the user can see "which one is me").
- Flag parsing lives in `bin/cli.js` alongside the existing `--no-docker` /
  `--poll` / `--root` flags; no new dependency.

### 3.3 Where filtering happens

Filter **at the source** (`src/docker.js` / a thin `src/pods.js` selector), not
in the frontend:

- Keeps the reconciler (`src/liveness.js`) and StateModel (`src/state.js`)
  unaware of pods for membership purposes — they receive an already-scoped
  container list, preserving the clean enter/update/exit logic.
- Means scoped-out containers never consume WS bandwidth or animation budget.
- The **pod attribution itself** (podId/podLabel) still flows through to state in
  multi-pod mode so the frontend can color/group; in single-pod mode it is
  carried but uniform.

---

## 4. Visual distinction design

### 4.1 Single-pod (default) — essentially unchanged

With scoping on, the graph is exactly today's: one `scrum-master` hub, concentric
rings, inferred dashed spokes (`public/app.js`, redesign §3.2). The only addition
is a small **pod badge** in the toolbar showing the self-pod label
(`path.basename(selfPodRoot)`), e.g. `pod: voltron-glimpse`, next to the existing
connection + Docker-availability badges (redesign §5.2). This reassures the user
*which* project they are watching.

### 4.2 Multi-pod (`--all-pods` / `--pod`) — group + color, one hub per pod

When more than one pod is shown, render each pod as a **visually separated
cluster**, because mixing them onto one hub is precisely the dishonesty to fix.

**(a) Per-pod hue.** Assign each `podId` a distinct, stable hue (deterministic
from the podId — hash → hue, no `Math.random`, mirroring the deterministic
phase-jitter approach in redesign §4.2). The hue tints the pod's **hub**, its
**spokes**, and a thin **node border/halo** on its agents. Status color (green
`working`, red `exiting:errored`, etc. from `statusMachine`) stays the **fill**
so liveness reads first; the pod hue is a **secondary accent** (border ring /
backplate), never overriding the live-state color. This keeps the §2.4 state
language intact while adding pod identity as an orthogonal channel.

**(b) One hub per pod.** This is the key structural change. The synthetic hub is
no longer global. `src/model/edges.js` must build **one hub per distinct pod**,
labeled with the pod's basename (e.g. hub id `scrum-master@<podId>`, label
`scrum-master · voltron-glimpse`), with that pod's agents as its spokes. With the
journal-driven hub from `docs/scrum-master-monitor-design.md`, **each pod's hub
liveness is driven by that pod's own journal** (`<podRoot>/.voltron/journal/…`) —
so in multi-pod mode the watcher must tail each shown pod's journal directory, and
the reconciler keys hub liveness by pod. (In single-pod mode this is just the one
self-pod journal Glimpse already could watch.)

**(c) Cluster grouping (layout).** Two honest options; recommend starting with
the lighter one:

- **Recommended (v1): per-pod compound parent nodes.** Wrap each pod's hub+agents
  in a Cytoscape **compound parent** (a labeled, tinted bounding box). Compound
  nodes are core Cytoscape — no new vendor lib. Run the existing `concentric`
  layout **within** each compound, and a simple grid/packed arrangement **of** the
  compounds. The parent's label is the pod basename; its tint is the pod hue. This
  gives an unmistakable "these belong together" boundary.
- **Alternative (heavier): separate concentric clusters by angular sector** with
  no bounding box — cheaper visually but easier to misread when pods overlap.
  Defer unless compounds prove busy.

**(d) Pod legend.** Add a small legend pill list (one row per shown pod: hue swatch
+ basename + live-node count), reusing the legend region the redesign already
keeps (§5.2). The self pod is marked (e.g. a "● you" dot) so the user always knows
which cluster is theirs.

**(e) Honesty.** Pod membership is **real** (mount-derived) — so, unlike the
inferred dashed dispatch spokes, the **pod boundary/box is drawn solid**. The
legend states "pod = project root (real); spokes = inferred dispatch," preserving
the real-vs-inferred distinction the redesign insists on (§3.1, §3.3).

### 4.3 Multi-hub summary

| Mode | Hubs | Journals watched | Coloring |
|---|---|---|---|
| default (scoped) | 1 (self pod) | self pod only | status color only + self-pod badge |
| `--all-pods` / `--pod` | **one per shown pod** | one per shown pod | status fill + per-pod hue accent + compound box |

This directly resolves the "multiple hubs — one per pod's journal?" question:
**yes — one hub per pod, each hub's liveness fed by that pod's journal**,
consistent with `docs/scrum-master-monitor-design.md` §2.2.

### 4.4 Frontend touch-points (for the build order)

`public/app.js` (`ensureHubNode` → `ensureHubNodeForPod(podId)`),
`public/cytoscape-style.js` (pod-hue accent classes, compound-parent style,
solid pod boundary), `public/styles.css` (legend rows, pod badge). The WS
snapshot/patch gains a `pods` map (`{ podId: { label, root, isSelf, color } }`)
and each agent/edge/hub carries its `podId`.

---

## 5. Read-only + cost constraints

- **Read-only (non-negotiable).** `docker inspect` is a **read** — like
  `docker ps`, it never mutates a container. The allowed Docker verbs remain
  `ps` and `inspect` **only**; never `run`/`stop`/`rm`/`exec`/`create`
  (CLAUDE.md, redesign §1.2). Reading a pod's `<podRoot>/.voltron/journal/*.md`
  for multi-pod hub liveness is a **read/stat only** — **never** `fs.write*`,
  `appendFile`, `mkdir`, or `rm` under any `.voltron/` or `.beads/` of **any**
  pod (this widens the read-only audit to *other* projects' `.voltron/`, which
  must be honored just as strictly as the self pod's).
- **Honest attribution.** Pod identity is derived from a real host fact (the
  mount source). Where it cannot be determined (inspect failure), label the node
  `pod: unknown` rather than guessing a pod — never assign a container to a pod we
  did not prove.
- **Cost / cadence.** One `inspect` **per new container id, cached for its
  lifetime** (§2.5); steady-state polls do **zero** inspects; dispatch bursts do
  **one batched** inspect. The 1 s `docker ps` cadence (redesign §4.6) is
  unchanged. Scoped-out (non-self) containers in default mode are inspected at
  most once to classify them, then ignored. Multi-pod journal watching adds at
  most one chokidar watch per shown pod (bounded by the number of distinct pods,
  typically 2–3).
- **Degrade gracefully.** Daemon down → existing log-freshness fallback
  (redesign §2.5); in that mode pod attribution from `inspect` is unavailable, so
  Glimpse falls back to **single (self) pod** and shows a "pod attribution
  unavailable" note. A missing/locked journal in another pod tolerates errors and
  simply leaves that pod's hub static, never crashing the observer.

---

## 6. Build order (ordered, single-agent-sized tasks)

Each task is small enough for one specialist agent and ends with a concrete
verification. Tasks marked **HOST-ONLY** need a live Docker daemon and are handed
to the user/scrum-master (a container-run agent cannot query the host daemon —
redesign §7). P1–P4 are the scoping MVP; P5–P8 are multi-pod visuals; P9 is the
gate.

**P1 — Pod resolver + inspect caching (`src/pods.js` or extend `src/docker.js`).**
Add `resolvePods(containers, { exec, cache })` that, for each **new** container id,
runs a batched `docker inspect … --format` to extract the `/workspace` mount
source, normalizes it (`path`, Windows-tolerant), and returns `{ podId, podRoot,
podLabel }`; caches by container id; evicts gone ids; attributes `unknown` on
failure without throwing. `exec` injectable for tests.
*Verify:* `test/pods.test.js` (node:test) against a captured `docker inspect`
JSON fixture — asserts mount-source extraction, basename label, Windows-path
normalization, cache-hit (no re-inspect for a known id), and `unknown` on a
malformed/empty inspect. Container-safe (fixture + injected exec).

**P2 — Wire pod fields into `pollDocker`.**
Extend `src/docker.js` so each row carries `podId`/`podRoot`/`podLabel` (§2.6) by
calling the P1 resolver; keep the existing fields and the "never throws" contract.
*Verify:* extend `test/docker.test.js` — rows gain pod fields from a combined
`docker-ps.txt` + `docker-inspect.json` fixture; a row with failed inspect still
parses with `podLabel: 'unknown'`. Container-safe.

**P3 — Self-pod scoping + flag parsing (`bin/cli.js` + selector).**
Resolve `selfPodRoot` from `resolveProjectRoot`; add `--all-pods`,
`--pod <label|path>` (repeatable) parsing; add a `selectPods(rows, opts,
selfPodRoot)` filter that, by default, keeps only self-pod rows, and in
all-pods/explicit modes keeps the requested set. Filter **before** the reconciler.
*Verify:* `test/pods.test.js` (selector section) — default keeps only self-pod
rows; `--all-pods` keeps all; `--pod foo` keeps only matching basename/path;
path-equality is normalization-aware. Container-safe (pure function).

**P4 — Self-pod badge (frontend, single-pod).**
Add a `pod: <basename>` badge to the toolbar next to the connection/Docker badges;
carry `selfPodLabel` in the WS snapshot. No structural graph change.
*Verify:* `node --check public/app.js`; load `index.html` against a canned
snapshot — badge shows the self-pod basename; no console errors. Browser-checkable
in-container via static serve.

**P5 — Multi-hub edges (`src/model/edges.js`).**
Change `buildLiveEdges` to build **one hub per distinct `podId`** present in the
live set (hub id namespaced by pod; spokes connect a pod's hub to that pod's
agents only). Single-pod input yields exactly today's one-hub output
(back-compat).
*Verify:* unit test — a live set spanning two pods yields two hubs and pod-local
spokes; a single-pod set yields one hub identical to current output. Container-safe.

**P6 — Per-pod journal liveness (reconciler + watcher).**
In multi-pod mode, key hub liveness by pod: the watcher tails each shown pod's
`<podRoot>/.voltron/journal/*.md` (read-only, offset-tracked, per
`docs/scrum-master-monitor-design.md`); the reconciler records `lastJournalTs`
**per pod** and emits per-pod `HUB_UPDATE`. Depends on the journal-hub feature
landing first (or stub the hub as static-per-pod if it has not).
*Verify:* `test/liveness.test.js` — scripted per-pod journal events + fake clock
drive independent hub states for two pods; one pod going idle does not affect the
other. Container-safe.

**P7 — StateModel `pods` map (`src/state.js`).**
Hold a `pods: { [podId]: { label, root, isSelf, color } }` map; attach `podId` to
agents/edges/hubs in `snapshot()`; assign deterministic hue per podId. No history.
*Verify:* unit test — snapshot includes the pods map; hue is stable across calls
for the same podId; `isSelf` set correctly. Container-safe.

**P8 — Multi-pod rendering (frontend).**
`public/app.js`: `ensureHubNodeForPod`, compound parent per pod, pod-hue accent
on hubs/spokes/node-halos, pod legend with self marker; consume the `pods` map and
per-element `podId`. `cytoscape-style.js`/`styles.css`: compound-box (solid
boundary = real membership), hue accent classes, legend rows.
*Verify:* `node --check public/app.js`; feed a scripted two-pod WS scenario from a
stub server — two tinted compound clusters with separate hubs, legend lists both
pods with the self marker, status colors still read as fill; no console errors.
Browser-checkable in-container via stub WS.

**P9 — HOST-ONLY end-to-end + read-only audit.**
On the host with **two** real Voltron projects dispatching at once: confirm
default mode shows only the launching project's containers; `--all-pods` shows
both as separate tinted clusters with one hub each; `--pod <other>` scopes to the
other project. Re-run the read-only audit **widened to all pods' `.voltron/`**
(`grep` shows zero `fs.write*`/`appendFile`/`mkdir`/`rm` under any `.voltron/`;
confirm only `docker ps` + `docker inspect` reads). **HOST-ONLY** — qa-tester
prepares the script/checklist; the human/scrum-master executes and reports back.
This is the gating acceptance test (cannot run inside a container — needs the host
daemon + two real projects).

---

## 7. Open questions (need human input)

1. **Default really scope-to-self?** Confirmed recommendation: **yes** (it is the
   reported bug's most direct fix and keeps the one-hub model honest). Flagged
   because it is a visible behavior change for anyone who *liked* seeing
   everything — those users get `--all-pods`.
2. **Compound boxes vs angular sectors** for multi-pod grouping (§4.2c). Recommend
   compound parents first; revisit if the canvas feels boxed-in.
3. **`unknown`-pod containers** (inspect failed): show them in default mode or
   hide them? Recommend **show, labeled `pod: unknown`**, so a container is never
   silently dropped — but they cannot be scoped reliably.
4. **Session-level pods** are out of scope (§2.4) absent a launcher label. If
   Voltron adds a project/session `--label`, prefer it and revisit (§2.3).

---

*Design saved to `docs/pod-distinction-design.md`. Invoke `/scrum-master` with
this document to decompose §6 (Build order) into agent tasks.*
