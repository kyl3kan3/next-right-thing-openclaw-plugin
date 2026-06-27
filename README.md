# Next Right Thing OpenClaw Plugin

OpenClaw hook plugin for the Next Right Thing protocol.

It adds a model-agnostic Next Right Thing run context, approval gates around
risky tool calls, a runtime coverage preflight, and a completion-audit hook
surface for agents that should keep moving while preserving evidence,
verification, and safety.

## Install

```bash
openclaw plugins install git:github.com/kyl3kan3/next-right-thing-openclaw-plugin@v0.3.4-openclaw
openclaw plugins enable next-right-thing
openclaw gateway restart
openclaw plugins inspect next-right-thing --runtime --json
```

> Installs the current stable release. To test unreleased changes instead, replace
> the tag with `@main`.

### Required: grant hook permissions (one line)

The model-agnostic run context uses `before_prompt_build`; runtime coverage and
reflective deliberation use `before_agent_run` and `before_agent_finalize`.
OpenClaw gates those surfaces behind operator-granted permissions. They cannot
be auto-enabled by the plugin -- add this once to your OpenClaw config so the
NRT layer actually fires across models:

```json
{ "plugins": { "entries": { "next-right-thing": {
  "hooks": { "allowPromptInjection": true, "allowConversationAccess": true }
} } } }
```

Without it OpenClaw-owned tool-call approval still works, but the run context,
runtime coverage, and reflection stay off. See [Configuration](#configuration)
for the full options.

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

### Runtime and native shell safety

`before_prompt_build` injects the Next Right Thing operating context for any
model that reaches OpenClaw's hook runner. `before_agent_run` is the preflight
that proves the plugin layer was invoked before inference; by default it is
model-agnostic and does **not** block Claude CLI, Anthropic, OpenAI, or
unidentified runtimes merely because of their model/provider id.

`before_tool_call` then wraps OpenClaw-owned dynamic tools that reach the hook
surface. If you need strict host-level tool coverage, configure
`runtimeCoverage.blockedRuntimeIds`, `runtimeCoverage.blockedProviderIds`, or
`runtimeCoverage.allowUnidentifiedRuntime: false` to block specific uncovered
paths before inference.

For host runtimes that own native shell execution outside OpenClaw's hook relay,
keep OpenClaw's native exec policy out of YOLO mode (`security=full`, `ask=off`)
so destructive shell commands still require approval.

Recommended baseline:

```bash
openclaw config patch --stdin <<'JSON'
{"tools":{"exec":{"security":"allowlist","ask":"on-miss","strictInlineEval":true}}}
JSON
openclaw gateway restart
```

If your agents have `agents.list[].tools.exec` overrides, set those overrides to
the same `security=allowlist`, `ask=on-miss`, and `strictInlineEval=true` values.
The verification script fails by default unless runtime inspect shows the
`before_prompt_build` run-context hook, the `before_agent_run` coverage gate,
and the `before_tool_call` approval gate. It also fails when it sees
`security=full` plus `ask=off`; set
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

Expected result: the model receives the Next Right Thing run context, and
OpenClaw-owned tools ask for a next-right-thing approval instead of executing
directly. If strict `runtimeCoverage` blocking is configured, matching runtime
or provider ids are blocked before inference.

## Configuration

Config knobs are set under the plugin's entry in your OpenClaw config:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `approvalTimeoutMs` | integer (ms) | `60000` | How long to wait for an approval decision before denying. Times out to **deny** (fail-safe). |
| `runContext.enabled` | boolean | `true` | Inject the model-agnostic Next Right Thing operating context with `before_prompt_build`. |
| `runContext.instruction` | string | built-in NRT context | Optional replacement for the default run-context instruction. |
| `runtimeCoverage.enforce` | boolean | `true` | Register the `before_agent_run` preflight. |
| `runtimeCoverage.allowUnidentifiedRuntime` | boolean | `true` | Allow runs when OpenClaw provides no runtime/provider/model identity. Set `false` only for strict host coverage. |
| `runtimeCoverage.blockedRuntimeIds` | string[] | `[]` | Optional runtime ids to block before inference when strict tool coverage is required. |
| `runtimeCoverage.blockedProviderIds` | string[] | `[]` | Optional provider ids to block before inference when strict tool coverage is required. |
| `runtimeCoverage.message` | string | built-in block text | Operator-facing block message for strict runtime-coverage blocks. |
| `reflection.enabled` | boolean | `true` | Master switch for the built-in reflective deliberation (below). |
| `reflection.reviewRoles` | string[] | `[]` | Extra review lenses to include — any of `critic`, `verifier`, `security`, `fact_checker`, `memory_curator`. |
| `reflection.maxAttempts` | integer ≥ 1 | `1` | How many times to ask the model to reflect before letting it finalize. |

```json
{ "plugins": { "entries": { "next-right-thing": {
  "hooks": { "allowPromptInjection": true, "allowConversationAccess": true },
  "config": {
    "approvalTimeoutMs": 60000,
    "runContext": { "enabled": true },
    "runtimeCoverage": { "enforce": true, "allowUnidentifiedRuntime": true },
    "reflection": { "enabled": true, "reviewRoles": ["security"] }
  }
} } } }
```

> **Required for model-wide NRT context, runtime coverage, and finalize
> reflection.** OpenClaw gates `before_prompt_build` behind
> `allowPromptInjection`, and `before_agent_run` / `before_agent_finalize`
> behind `allowConversationAccess`, so a non-bundled plugin must set both hook
> permissions on its entry (alongside `config`). Without them OpenClaw-owned
> tool-call approval still works, but the model-wide run context, run gate, and
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
