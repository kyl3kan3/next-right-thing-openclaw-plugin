# Next Right Thing OpenClaw Plugin

OpenClaw hook plugin for the Next Right Thing protocol.

It adds approval gates around risky tool calls, a fail-closed runtime coverage
gate, and a completion-audit hook surface for agents that should keep moving
while preserving evidence, verification, and safety.

## Install

```bash
openclaw plugins install git:github.com/kyl3kan3/next-right-thing-openclaw-plugin@v0.3.4-openclaw
openclaw plugins enable next-right-thing
openclaw gateway restart
openclaw plugins inspect next-right-thing --runtime --json
```

> Installs the current stable release. To test unreleased changes instead, replace
> the tag with `@main`.

### Required: grant conversation access (one line)

The runtime-coverage and reflective-deliberation features run on
`before_agent_run` and `before_agent_finalize`, which OpenClaw gates behind an
operator-granted permission. It cannot be auto-enabled by the plugin -- add this
once to your OpenClaw config so the safety layer actually fires before inference:

```json
{ "plugins": { "entries": { "next-right-thing": {
  "hooks": { "allowConversationAccess": true }
} } } }
```

Without it OpenClaw-owned tool-call approval still works, but runtime coverage
and reflection stay off. See [Configuration](#configuration) for the full
options.

## Smoke Test

On the OpenClaw host, run the packaged verification script:

```bash
curl -fsSL -o /tmp/verify-openclaw-install.sh https://raw.githubusercontent.com/kyl3kan3/next-right-thing-openclaw-plugin/v0.3.4-openclaw/scripts/verify-openclaw-install.sh
bash /tmp/verify-openclaw-install.sh
```

For CLI-level smoke tests, use a healthy Gateway or force the embedded local
runner with `openclaw agent --local --json ...`. If a JSON result reports
`meta.fallbackFrom: "gateway"`, the Gateway request failed and OpenClaw used an
automatic fallback path; restart the Gateway and rerun before treating the smoke
as evidence of hook coverage.

### Required for runtime and native shell safety

`before_agent_run` is the always-on safety layer: by default it allows
hook-covered embedded runtimes and blocks known uncovered runtime paths such as
`claude-cli`/`anthropic-cli`, plus unidentified runtime paths. `before_tool_call`
then wraps OpenClaw-owned dynamic tools that do reach the hook surface.

If you intentionally disable or relax `runtimeCoverage`, or run a host runtime
that owns native shell execution outside OpenClaw's hook relay, keep OpenClaw's
native exec policy out of YOLO mode (`security=full`, `ask=off`) so destructive
shell commands still require approval.

Recommended baseline:

```bash
openclaw config patch --stdin <<'JSON'
{"tools":{"exec":{"security":"allowlist","ask":"on-miss","strictInlineEval":true}}}
JSON
openclaw gateway restart
```

If your agents have `agents.list[].tools.exec` overrides, set those overrides to
the same `security=allowlist`, `ask=on-miss`, and `strictInlineEval=true` values.
The verification script fails by default unless runtime inspect shows both the
`before_agent_run` coverage gate and the `before_tool_call` approval gate. It
also fails when it sees `security=full` plus `ask=off`; set
`REQUIRE_SAFE_EXEC_POLICY=0` only when you intentionally want to test hook
registration without hardening native exec.

Ask OpenClaw to run a safe command first:

```text
Run: npm test
```

Then test a gated action:

```text
Run: vercel deploy --prod
```

Expected result: OpenClaw-owned tools ask for a next-right-thing approval instead
of executing directly. Runs whose runtime cannot be proven hook-covered,
including Claude CLI/native runtime paths, are blocked before inference unless
you explicitly relax `runtimeCoverage` or route them through a hook-covered
runtime/native relay.

## Configuration

Config knobs are set under the plugin's entry in your OpenClaw config:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `approvalTimeoutMs` | integer (ms) | `60000` | How long to wait for an approval decision before denying. Times out to **deny** (fail-safe). |
| `runtimeCoverage.enforce` | boolean | `true` | Register the fail-closed `before_agent_run` gate. |
| `runtimeCoverage.allowUnidentifiedRuntime` | boolean | `false` | Allow runs when OpenClaw provides no runtime/provider/model identity. Keep `false` unless another layer proves hook coverage. |
| `runtimeCoverage.blockedRuntimeIds` | string[] | `["claude-cli","anthropic-cli"]` | Runtime ids treated as uncovered and blocked before inference. |
| `runtimeCoverage.blockedProviderIds` | string[] | `["claude-cli"]` | Provider ids treated as uncovered and blocked before inference. |
| `runtimeCoverage.message` | string | built-in block text | Operator-facing block message for uncovered runtime paths. |
| `reflection.enabled` | boolean | `true` | Master switch for the built-in reflective deliberation (below). |
| `reflection.reviewRoles` | string[] | `[]` | Extra review lenses to include — any of `critic`, `verifier`, `security`, `fact_checker`, `memory_curator`. |
| `reflection.maxAttempts` | integer ≥ 1 | `1` | How many times to ask the model to reflect before letting it finalize. |

```json
{ "plugins": { "entries": { "next-right-thing": {
  "hooks": { "allowConversationAccess": true },
  "config": {
    "approvalTimeoutMs": 60000,
    "runtimeCoverage": { "enforce": true, "allowUnidentifiedRuntime": false },
    "reflection": { "enabled": true, "reviewRoles": ["security"] }
  }
} } } }
```

> **Required for runtime coverage and finalize reflection.** OpenClaw gates
> `before_agent_run` and `before_agent_finalize` behind a conversation-access
> permission, so a non-bundled plugin must set
> `hooks.allowConversationAccess: true` on its entry (alongside `config`).
> Without it OpenClaw-owned tool-call approval still works, but the run gate and
> reflection hook never run. See
> OpenClaw's [plugin permission docs](https://docs.openclaw.ai/plugins/plugin-permission-requests).

## Reflective Deliberation

By default — with **no** external runtime — the plugin makes the agent *contemplate
before it finalizes*. On the agent's first attempt to declare it is done, the
`before_agent_finalize` hook returns one `revise` that asks the model to:

1. restate the active goal in one sentence,
2. state the concrete evidence that it is actually done,
3. if it is not fully done, name at least one **next right thing** and do it, and
4. self-review through the configured review lenses (`critic`, `verifier`, …).

It is a **one-shot** (`reflection.maxAttempts: 1` with a stable idempotency key), so it
asks once and then lets finalize proceed — never an infinite loop. Set
`reflection.enabled: false` (statically or at the plugin level) to turn it off; that is a
startup decision, so a per-call `event.context.pluginConfig` override can disable or tune
reflection for a turn but cannot re-enable it when it is globally off. If you also wire a `loadCompletionAudit`
callback (see `plugin-entry.example.ts`), an evidence-based audit `revise` takes
precedence over the built-in reflection; the two use distinct idempotency keys.

## Autonomous operation (optional)

The plugin keeps each turn honest but does not *drive* the agent — OpenClaw acts only when
prompted. For an agent that **keeps doing the next right thing on its own**, the optional
[`heartbeat/`](heartbeat/README.md) companion periodically prompts your gateway from a layered
goal model (mission + backlog + recent context), with this plugin gating risk on every turn it
triggers. It ships idle and dry-run by default. See [`heartbeat/README.md`](heartbeat/README.md).

## Tests

This repository is self-contained and dependency-free — no install step is
needed to run the suite:

```bash
npm test        # or: node --test
```

`tests/hooks.test.mjs` covers side-effect inference (destructive shell, SQL,
production, publish, secrets), approval-prompt shape, severity, config
threading, and the `fixtures/simulate-runtime.mjs` hook fixture.

> The separate full Next Right Thing source tree additionally ships
> `tests/test_openclaw_adapter.mjs` and `runtime/nrt_security_scan.py`; those
> are out of scope for this adapter repository.

## License

[MIT](LICENSE)
