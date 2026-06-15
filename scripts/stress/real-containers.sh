#!/usr/bin/env bash
#
# T6 — Real-container generator for V11 (host-only, escalated).
#
# ⚠️  RUN THIS ON THE HOST, NOT INSIDE A VOLTRON AGENT CONTAINER.
#     Container-run agents cannot query the host Docker daemon
#     (docs/live-monitor-redesign.md §7 B11). The smoke set never invokes this.
#
# What it does (read §Read-only & safety discipline of docs/stress-test-plan.md):
#   1. `docker run -d` N throwaway alpine sleeper containers named
#      voltron-stress-<agent>-<ISO>-<suffix> so Glimpse's `name=voltron-` filter
#      matches them. Each emits a `step` line every second so `docker logs -f`
#      sees activity and the node pulses.
#   2. Lets you watch them appear in Glimpse (run `voltron-glimpse` separately).
#   3. On exit (or Ctrl-C) `docker rm -f` ONLY containers with the
#      voltron-stress- prefix — never touches a real Voltron container.
#
# It NEVER stop/rm/exec's a container it did not create: teardown is filtered to
# the unique `voltron-stress-` prefix, which is distinct from any real agent name.
#
# Usage:
#   scripts/stress/real-containers.sh [COUNT] [LIFETIME_SECONDS]
#     COUNT             number of sleeper containers (default 15)
#     LIFETIME_SECONDS  how long to keep them up before teardown (default 60)
#
set -euo pipefail

COUNT="${1:-15}"
LIFETIME="${2:-60}"
PREFIX="voltron-stress-"
ISO="$(date -u +%Y-%m-%dT%H-%M-%S)"
AGENTS=(fullstack-dev qa-tester ui-designer devops-engineer project-planner scrum-master)

created=()

cleanup() {
  echo ""
  echo "[real-containers] tearing down ${PREFIX}* containers (rm -f, prefix-filtered)…"
  # Only remove our own prefixed throwaways. Never a real Voltron container.
  ids="$(docker ps -aq --filter "name=${PREFIX}" 2>/dev/null || true)"
  if [ -n "${ids}" ]; then
    # shellcheck disable=SC2086
    docker rm -f ${ids} >/dev/null 2>&1 || true
  fi
  echo "[real-containers] teardown complete."
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null 2>&1 || {
  echo "docker not found on PATH — this script is host-only." >&2
  exit 1
}

echo "[real-containers] launching ${COUNT} throwaway sleepers (lifetime ${LIFETIME}s)…"
for i in $(seq 1 "${COUNT}"); do
  agent="${AGENTS[$(( (i - 1) % ${#AGENTS[@]} ))]}"
  sfx="$(printf '%04x' "$i")"
  name="${PREFIX}${agent}-${ISO}-${sfx}"
  docker run -d --rm --name "${name}" alpine:3 \
    sh -c 'i=0; while true; do i=$((i+1)); echo "[STEP $i] working"; sleep 1; done' \
    >/dev/null
  created+=("${name}")
  echo "  + ${name}"
done

echo "[real-containers] ${#created[@]} containers up. Start the monitor in another shell:"
echo "    voltron-glimpse"
echo "[real-containers] holding ${LIFETIME}s, then removing in waves…"

# Remove in waves to exercise enter→exit churn against the live daemon.
half=$(( COUNT / 2 ))
sleep $(( LIFETIME / 2 ))
echo "[real-containers] wave 1: removing ${half} containers…"
for i in $(seq 1 "${half}"); do
  docker rm -f "${created[$((i-1))]}" >/dev/null 2>&1 || true
done
sleep $(( LIFETIME / 2 ))
echo "[real-containers] wave 2: removing the rest…"
# trap cleanup handles the remainder on exit
