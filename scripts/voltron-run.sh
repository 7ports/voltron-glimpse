#!/bin/bash
# Voltron Docker launcher — starts Claude Code with full agent autonomy
# Usage: ./scripts/voltron-run.sh
#        ./scripts/voltron-run.sh -p "invoke /scrum-master to plan the backlog"

docker build -t voltron-agent -f Dockerfile.voltron . 2>/dev/null

# v3.4.1: Auth path = narrow OAuth credentials mount + env-var passthrough.
# DO NOT mount full ~/.claude or ~/.claude.json — the latter contains host-pathed
# MCP server registrations that hang the Linux container at startup (60-90s+).
# Mount ONLY ~/.claude/.credentials.json (the OAuth token file) when present.
# On Windows, run `claude setup-token` once to materialize this file (otherwise
# auth lives in Windows Credential Manager and the Linux container can't reach it).
AUTH_ARGS=()
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && AUTH_ARGS+=(-e "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN")
[ -n "$ANTHROPIC_API_KEY" ] && AUTH_ARGS+=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")

# v3.13.0: GitHub publish credentials. Supplied by the host via env var so the
# token never persists in an image layer. One-time host setup (pick one):
#   Unix:    export GH_TOKEN="$(gh auth token)"
#   Windows: $env:GH_TOKEN = (gh auth token)
#   Or set a fine-grained PAT directly as GH_TOKEN / GITHUB_TOKEN.
# Falls back to GITHUB_TOKEN if GH_TOKEN is unset. Entirely optional —
# read-only agents still run without it.
GH_ARGS=()
if [ -n "$GH_TOKEN" ]; then
  GH_ARGS+=(-e "GH_TOKEN=$GH_TOKEN")
elif [ -n "$GITHUB_TOKEN" ]; then
  GH_ARGS+=(-e "GH_TOKEN=$GITHUB_TOKEN")
fi

CREDS_MOUNT=()
[ -f "$HOME/.claude/.credentials.json" ] && CREDS_MOUNT+=(-v "$HOME/.claude/.credentials.json:/home/voltron/.claude/.credentials.json:ro")

if [ ${#AUTH_ARGS[@]} -eq 0 ] && [ ${#CREDS_MOUNT[@]} -eq 0 ]; then
  echo "Error: No auth available. Run 'claude setup-token' (creates ~/.claude/.credentials.json) or set CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY." >&2
  exit 1
fi

GIT_MOUNT=()
[ -f "$HOME/.gitconfig" ] && GIT_MOUNT+=(-v "$HOME/.gitconfig:/home/voltron/.gitconfig:ro")

docker run --rm -it \
  "${AUTH_ARGS[@]}" \
  "${GH_ARGS[@]}" \
  -v "$(pwd):/workspace" \
  "${CREDS_MOUNT[@]}" \
  "${GIT_MOUNT[@]}" \
  voltron-agent \
  --dangerously-skip-permissions \
  "$@"