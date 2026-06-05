# voltron-glimpse

Real-time, read-only visualizer companion for Project Voltron agent runs.

## Install

```bash
npm i -g voltron-glimpse
```

## Usage

```bash
voltron-glimpse
```

Dashboard wiring is not yet implemented — the current build is a scaffold only.

## Limitations

- Read-only observer — never writes under `.voltron/` or `.beads/`.
- Single-project scope; no multi-project aggregation.
- Bound to `127.0.0.1` only; no remote exposure, no auth.
- History is limited to whatever `.voltron/` holds on disk.
