#!/usr/bin/env bash
set -Eeuo pipefail

PLUGIN_ID="${PLUGIN_ID:-next-right-thing}"
PLUGIN_REF="${PLUGIN_REF:-v0.3.4-openclaw}"
PLUGIN_SPEC="${PLUGIN_SPEC:-git:github.com/kyl3kan3/next-right-thing-openclaw-plugin@${PLUGIN_REF}}"
SKIP_RESTART="${SKIP_RESTART:-0}"
REQUIRE_SAFE_EXEC_POLICY="${REQUIRE_SAFE_EXEC_POLICY:-1}"
REQUIRE_GATEWAY_EXEC_HOST="${REQUIRE_GATEWAY_EXEC_HOST:-1}"
REQUIRE_NATIVE_HOOK_RELAY="${REQUIRE_NATIVE_HOOK_RELAY:-1}"
# The run context (before_prompt_build) and runtime coverage (before_agent_run) hooks
# are opt-in layers (default off), so they are not required by default. Set these to 1
# when you have enabled those layers and want the verifier to prove they registered.
REQUIRE_RUN_CONTEXT="${REQUIRE_RUN_CONTEXT:-0}"
REQUIRE_RUNTIME_COVERAGE="${REQUIRE_RUNTIME_COVERAGE:-0}"
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
exec_config_file="$(mktemp)"
relay_help_file="$(mktemp)"
trap 'rm -f "$inspect_file" "$policy_file" "$exec_config_file" "$relay_help_file"' EXIT

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
if ! grep -q '"before_tool_call"' "$inspect_file"; then
  printf 'runtime inspect output did not show before_tool_call hook (the always-on approval gate)\n' >&2
  exit 14
fi
if grep -q '"before_prompt_build"' "$inspect_file"; then
  log "run-context hook present (before_prompt_build)"
elif [ "$REQUIRE_RUN_CONTEXT" = "1" ]; then
  printf 'runtime inspect output did not show before_prompt_build hook; enable runContext and set plugins.entries.%s.hooks.allowPromptInjection=true for the model-wide NRT context\n' "$PLUGIN_ID" >&2
  exit 12
else
  printf 'note: before_prompt_build (run context) not registered. It is opt-in; enable runContext + allowPromptInjection to use it, and set REQUIRE_RUN_CONTEXT=1 to require it here.\n'
fi
if grep -q '"before_agent_run"' "$inspect_file"; then
  log "runtime-coverage hook present (before_agent_run)"
elif [ "$REQUIRE_RUNTIME_COVERAGE" = "1" ]; then
  printf 'runtime inspect output did not show before_agent_run hook; enable runtimeCoverage.enforce and set plugins.entries.%s.hooks.allowConversationAccess=true for the runtime coverage gate\n' "$PLUGIN_ID" >&2
  exit 13
else
  printf 'note: before_agent_run (runtime coverage) not registered. It is opt-in; enable runtimeCoverage.enforce + allowConversationAccess to use it, and set REQUIRE_RUNTIME_COVERAGE=1 to require it here.\n'
fi
if grep -q 'allowPromptInjection=true\|allowConversationAccess=true' "$inspect_file"; then
  cat <<'EOF'

Note:
The plugin is loaded, but OpenClaw reports that hook permissions are missing.
Set plugins.entries.next-right-thing.hooks.allowPromptInjection=true for the
model-wide NRT context and allowConversationAccess=true for runtime coverage and
finalize reflection.
EOF
fi

log "Inspect OpenClaw exec policy"
if openclaw approvals get >"$policy_file" 2>&1; then
  cat "$policy_file"
  if grep -q 'security=full' "$policy_file" && grep -q 'ask=off' "$policy_file"; then
    cat <<'EOF' >&2

Unsafe exec policy detected:
At least one OpenClaw exec policy still shows security=full and ask=off.

The next-right-thing before_prompt_build hook carries NRT context across models,
before_agent_run proves the layer was invoked before inference, and
before_tool_call covers OpenClaw-owned dynamic tools. Claude CLI/native shell
execution can still be governed by OpenClaw's native exec policy, so YOLO exec
mode can bypass this plugin's tool approval prompt.

Recommended hardening:
  openclaw config patch --stdin <<'JSON'
  {"tools":{"exec":{"host":"gateway","security":"allowlist","ask":"on-miss","strictInlineEval":true}}}
  JSON

Also update any agents.list[].tools.exec overrides that still set
host=local, security=full, or ask=off, then restart the gateway.

Set REQUIRE_SAFE_EXEC_POLICY=0 to skip this verifier gate.
EOF
    if [ "$REQUIRE_SAFE_EXEC_POLICY" = "1" ]; then
      exit 16
    fi
  fi
else
  printf 'warning: could not inspect OpenClaw exec policy\n' >&2
  cat "$policy_file" >&2 || true
fi

log "Inspect OpenClaw exec host routing"
if openclaw config get tools.exec >"$exec_config_file" 2>&1; then
  cat "$exec_config_file"
  if [ "$REQUIRE_GATEWAY_EXEC_HOST" = "1" ] && ! grep -Eq '"host"[[:space:]]*:[[:space:]]*"gateway"' "$exec_config_file"; then
    cat <<'EOF' >&2

Gateway exec routing is not enabled:
tools.exec.host must be "gateway" so Codex/OpenClaw native shell execution is
routed through the gateway-owned policy and native hook relay surfaces.

Recommended hardening:
  openclaw config patch --stdin <<'JSON'
  {"tools":{"exec":{"host":"gateway","security":"allowlist","ask":"on-miss","strictInlineEval":true}}}
  JSON

Set REQUIRE_GATEWAY_EXEC_HOST=0 to skip this verifier gate.
EOF
    exit 17
  fi
  if [ "$REQUIRE_SAFE_EXEC_POLICY" = "1" ] && ! grep -Eq '"strictInlineEval"[[:space:]]*:[[:space:]]*true' "$exec_config_file"; then
    cat <<'EOF' >&2

strictInlineEval is not enabled:
Set tools.exec.strictInlineEval=true so inline shell evaluation remains inside
the OpenClaw exec policy boundary.

Set REQUIRE_SAFE_EXEC_POLICY=0 to skip this verifier gate.
EOF
    exit 18
  fi
else
  printf 'warning: could not inspect OpenClaw tools.exec config\n' >&2
  cat "$exec_config_file" >&2 || true
  if [ "$REQUIRE_GATEWAY_EXEC_HOST" = "1" ] || [ "$REQUIRE_SAFE_EXEC_POLICY" = "1" ]; then
    exit 21
  fi
fi

log "Inspect native hook relay command"
if openclaw hooks relay --help >"$relay_help_file" 2>&1; then
  cat "$relay_help_file"
  if ! grep -q 'Internal native harness hook relay' "$relay_help_file"; then
    printf 'native hook relay help did not identify the relay command\n' >&2
    if [ "$REQUIRE_NATIVE_HOOK_RELAY" = "1" ]; then
      exit 19
    fi
  fi
else
  cat "$relay_help_file" >&2 || true
  if [ "$REQUIRE_NATIVE_HOOK_RELAY" = "1" ]; then
    cat <<'EOF' >&2

Native hook relay command is unavailable:
OpenClaw must expose `openclaw hooks relay` for Codex app-server native hooks to
bridge PreToolUse/PostToolUse/Stop events into registered plugin policy.

Set REQUIRE_NATIVE_HOOK_RELAY=0 to skip this verifier gate.
EOF
    exit 20
  fi
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
executing directly (this is the always-on core gate). If you have enabled the
opt-in run context, any model that reaches OpenClaw's hook runner also receives
the Next Right Thing run context. Codex app-server native shell tools must
also be gateway-routed (`tools.exec.host="gateway"`) so their native hooks can
call `openclaw hooks relay` and reach the same pre-tool policy. Runtime/provider
ids are blocked before inference only when strict runtimeCoverage blocking is
explicitly configured.

For CLI JSON smoke tests, use a healthy Gateway or force the embedded local
runner with `openclaw agent --local --json ...`. If the result reports
meta.fallbackFrom="gateway", the Gateway request failed and the fallback result
is not proof of hook coverage; restart the Gateway and rerun.
EOF
