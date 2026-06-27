#!/usr/bin/env bash
set -Eeuo pipefail

PLUGIN_ID="${PLUGIN_ID:-next-right-thing}"
PLUGIN_REF="${PLUGIN_REF:-v0.3.4-openclaw}"
PLUGIN_SPEC="${PLUGIN_SPEC:-git:github.com/kyl3kan3/next-right-thing-openclaw-plugin@${PLUGIN_REF}}"
SKIP_RESTART="${SKIP_RESTART:-0}"
REQUIRE_SAFE_EXEC_POLICY="${REQUIRE_SAFE_EXEC_POLICY:-1}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"

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

if [ -z "${TMPDIR:-}" ]; then
  TMPDIR="$OPENCLAW_HOME/tmp"
  mkdir -p "$TMPDIR"
  export TMPDIR TMP="$TMPDIR" TEMP="$TMPDIR"
fi

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
policy_file="$(mktemp)"
trap 'rm -f "$inspect_file" "$policy_file"' EXIT

log "Inspect plugin runtime"
openclaw plugins inspect "$PLUGIN_ID" --runtime --json | tee "$inspect_file"

if ! grep -q "$PLUGIN_ID" "$inspect_file"; then
  printf 'runtime inspect output did not mention plugin id %s\n' "$PLUGIN_ID" >&2
  exit 10
fi
if ! grep -q '"status": "loaded"' "$inspect_file"; then
  printf 'runtime inspect output did not show status: loaded\n' >&2
  exit 11
fi
if ! grep -q '"before_agent_run"' "$inspect_file"; then
  printf 'runtime inspect output did not show before_agent_run hook; set plugins.entries.%s.hooks.allowConversationAccess=true for the runtime coverage gate\n' "$PLUGIN_ID" >&2
  exit 12
fi
if ! grep -q '"before_tool_call"' "$inspect_file"; then
  printf 'runtime inspect output did not show before_tool_call hook\n' >&2
  exit 14
fi
if grep -q 'allowConversationAccess=true' "$inspect_file"; then
  cat <<'EOF'

Note:
The plugin is loaded, but OpenClaw reports that conversation hooks need
plugins.entries.next-right-thing.hooks.allowConversationAccess=true. Runtime
coverage and finalize reflection depend on that permission.
EOF
fi

log "Inspect OpenClaw exec policy"
if openclaw approvals get >"$policy_file" 2>&1; then
  cat "$policy_file"
  if grep -q 'security=full' "$policy_file" && grep -q 'ask=off' "$policy_file"; then
    cat <<'EOF' >&2

Unsafe exec policy detected:
At least one OpenClaw exec policy still shows security=full and ask=off.

The next-right-thing before_agent_run hook blocks uncovered runtime paths by
default, and before_tool_call covers OpenClaw-owned dynamic tools. If
runtimeCoverage is disabled or relaxed, Claude CLI/native shell execution is
governed by OpenClaw's native exec policy, so YOLO exec mode can bypass this
plugin's approval prompt.

Recommended hardening:
  openclaw config patch --stdin <<'JSON'
  {"tools":{"exec":{"security":"allowlist","ask":"on-miss","strictInlineEval":true}}}
  JSON

Also update any agents.list[].tools.exec overrides that still set
security=full or ask=off, then restart the gateway.

Set REQUIRE_SAFE_EXEC_POLICY=0 to skip this verifier gate.
EOF
    if [ "$REQUIRE_SAFE_EXEC_POLICY" = "1" ]; then
      exit 13
    fi
  fi
else
  printf 'warning: could not inspect OpenClaw exec policy\n' >&2
  cat "$policy_file" >&2 || true
fi

log "Enabled plugin list"
openclaw plugins list --enabled --verbose

cat <<'EOF'

Manual smoke prompt to run in OpenClaw:

Run a safe command first, then a gated action.

Safe:
Run: npm test

Gated:
Run: vercel deploy --prod

Expected result:
OpenClaw-owned tools should show a next-right-thing approval prompt instead of
executing directly. Runs whose runtime cannot be proven hook-covered, including
Claude CLI/native runtime paths, should be blocked before inference unless
runtimeCoverage is explicitly relaxed or the runtime is routed through an
equivalent native relay/exec approval policy.

For CLI JSON smoke tests, use a healthy Gateway or force the embedded local
runner with `openclaw agent --local --json ...`. If the result reports
meta.fallbackFrom="gateway", the Gateway request failed and the fallback result
is not proof of hook coverage; restart the Gateway and rerun.
EOF
