#!/usr/bin/env bash
set -Eeuo pipefail

PLUGIN_ID="${PLUGIN_ID:-next-right-thing}"
PLUGIN_REF="${PLUGIN_REF:-v0.3.2-openclaw}"
PLUGIN_SPEC="${PLUGIN_SPEC:-git:github.com/kyl3kan3/next-right-thing-openclaw-plugin@${PLUGIN_REF}}"
SKIP_RESTART="${SKIP_RESTART:-0}"

log() {
  printf '\n==> %s\n' "$*"
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 127
  fi
}

need openclaw

log "OpenClaw version"
openclaw --version

log "Install plugin"
openclaw plugins install "$PLUGIN_SPEC"

log "Enable plugin"
openclaw plugins enable "$PLUGIN_ID"

if [ "$SKIP_RESTART" = "1" ]; then
  log "Gateway restart skipped"
else
  log "Restart gateway"
  openclaw gateway restart
fi

inspect_file="$(mktemp)"
trap 'rm -f "$inspect_file"' EXIT

log "Inspect plugin runtime"
openclaw plugins inspect "$PLUGIN_ID" --runtime --json | tee "$inspect_file"

if ! grep -q "$PLUGIN_ID" "$inspect_file"; then
  printf 'runtime inspect output did not mention plugin id %s\n' "$PLUGIN_ID" >&2
  exit 10
fi

log "Enabled plugin list"
openclaw plugins list --enabled --verbose

cat <<'EOF'

Manual smoke prompt to run in OpenClaw:

Run: vercel deploy --prod

Expected result:
OpenClaw should show a next-right-thing approval prompt instead of executing directly.
The approval should deny by default on timeout.
EOF
