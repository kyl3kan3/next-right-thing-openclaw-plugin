# Next Right Thing OpenClaw Plugin

OpenClaw hook plugin for the Next Right Thing protocol.

Its core is a single, always-on guardrail: an approval gate (`before_tool_call`)
around risky tool calls. Three additional layers — a model-agnostic run context
(`before_prompt_build`), a runtime-coverage preflight (`before_agent_run`), and a
completion/reflection hook (`before_agent_finalize`) — are **opt-in** and ship
**off by default**.

## Scope & charter

This plugin is **host policy that wraps prepared turns** — it gates and (when you
opt in) audits what an agent does. It deliberately does **not** select models or
providers, and it is **not** an agent harness.

- **Always on, no permissions:** the `before_tool_call` approval gate. This is the
  product. Installing the plugin gives you this and nothing else by default.
- **Opt-in (default off), each needs an operator-granted hook permission:** run
  context, runtime coverage, and finalize reflection. They *shape* or *audit* the
  turn rather than merely gating a tool, and each adds cost and/or a trust grant
  (`allowPromptInjection` / `allowConversationAccess`), so you enable them
  deliberately. See [Configuration](#configuration).
- **Separate companion (not part of this plugin):** the optional
  [`heartbeat/`](heartbeat/README.md) continuation engine *drives* an agent on a
  timer. It is a gateway client, not a hook, packaged as its own
  `@next-right-thing/heartbeat` module — see
  [Autonomous operation](#autonomous-operation-optional).
- **Out of scope for this repository:** the Python Next Right Thing runtime
  (`nrt reviews`/`scheduler`/`supervisor`, `nrt_security_scan.py`). This adapter
  is dependency-free; wire that separate source tree in via `loadCompletionAudit`
  only if you run it.

## Install

```bash
openclaw plugins install git:github.com/kyl3kan3/next-right-thing-openclaw-plugin@v0.3.4-openclaw
openclaw plugins enable next-right-thing
openclaw gateway restart
openclaw plugins inspect next-right-thing --runtime --json
```

> Installs the current stable release. To test unreleased changes instead, replace
> the tag with `@main`.

### The core gate needs no permissions

Out of the box you get the `before_tool_call` approval gate, which needs no
special hook permission. If you do not want anything else, you are done.

### Optional: enable the opt-in layers (config + permissions)

The run context (`before_prompt_build`), runtime coverage (`before_agent_run`),
and finalize reflection (`before_agent_finalize`) are off by default. To turn any
of them on you must **both** enable it in `config` **and** grant the hook
permission OpenClaw gates it behind — the plugin cannot self-grant these:

```json
{ "plugins": { "entries": { "next-right-thing": {
  "hooks": { "allowPromptInjection": true, "allowConversationAccess": true },
  "config": {
    "runContext": { "enabled": true },
    "runtimeCoverage": { "enforce": true },
    "reflection": { "enabled": true }
  }
} } } }
```

`allowPromptInjection` is needed for the run context; `allowConversationAccess`
for runtime coverage and reflection. See [Configuration](#configuration) for the
full options.

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

`before_tool_call` (always on) wraps OpenClaw-owned dynamic tools that reach the
hook surface. When you opt in, `before_prompt_build` injects the Next Right Thing
operating context for any model that reaches OpenClaw's hook runner, and
`before_agent_run` is the preflight that proves the plugin layer was invoked
before inference; even when enabled it is model-agnostic by default and does
**not** block Claude CLI, Anthropic, OpenAI, or unidentified runtimes merely
because of their model/provider id.

If you need strict host-level tool coverage, enable `runtimeCoverage.enforce` and
configure
`runtimeCoverage.blockedRuntimeIds`, `runtimeCoverage.blockedProviderIds`, or
`runtimeCoverage.allowUnidentifiedRuntime: false` to block specific uncovered
paths before inference.

For host runtimes that own native shell execution, route exec through the
OpenClaw gateway and keep the native exec policy out of YOLO mode
(`security=full`, `ask=off`). On OpenClaw 2026.6.10 the Codex app-server harness
can bridge native `PreToolUse` / `PostToolUse` / `Stop` callbacks into OpenClaw
with `openclaw hooks relay`; that relay is what lets native shell calls reach
the same `before_tool_call` policy used by OpenClaw-owned dynamic tools. If exec
is left on a local/native host or YOLO policy, destructive shell commands can
execute without this plugin's approval prompt.

Recommended baseline:

```bash
openclaw config patch --stdin <<'JSON'
{"tools":{"exec":{"host":"gateway","security":"allowlist","ask":"on-miss","strictInlineEval":true}}}
JSON
openclaw gateway restart
```

If your agents have `agents.list[].tools.exec` overrides, set those overrides to
the same `host=gateway`, `security=allowlist`, `ask=on-miss`, and
`strictInlineEval=true` values.
The verification script fails by default unless runtime inspect shows the
`before_tool_call` approval gate (the always-on core). The opt-in
`before_prompt_build` and `before_agent_run` hooks are **not** required by
default; set `REQUIRE_RUN_CONTEXT=1` or `REQUIRE_RUNTIME_COVERAGE=1` to require
them once you have enabled those layers. The script also fails when it sees
`security=full` plus `ask=off`, when `tools.exec.host` is not `gateway`, when
`strictInlineEval` is not enabled, or when `openclaw hooks relay` is unavailable.
Set `REQUIRE_SAFE_EXEC_POLICY=0`, `REQUIRE_GATEWAY_EXEC_HOST=0`, or
`REQUIRE_NATIVE_HOOK_RELAY=0` only when you intentionally want to test hook
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
of executing directly (the always-on core gate). If you enabled the run context,
the model also receives the Next Right Thing operating context; if strict
`runtimeCoverage` blocking is configured, matching runtime or provider ids are
blocked before inference.

## Configuration

Config knobs are set under the plugin's entry in your OpenClaw config:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `approvalTimeoutMs` | integer (ms) | `60000` | How long to wait for an approval decision before denying. Times out to **deny** (fail-safe). Applies to the always-on approval gate. |
| `runContext.enabled` | boolean | `false` | **Opt-in.** Inject the model-agnostic Next Right Thing operating context with `before_prompt_build`. Needs `allowPromptInjection`. |
| `runContext.instruction` | string | built-in NRT context | Optional replacement for the default run-context instruction. |
| `runtimeCoverage.enforce` | boolean | `false` | **Opt-in.** Register the `before_agent_run` preflight. Needs `allowConversationAccess`. |
| `runtimeCoverage.allowUnidentifiedRuntime` | boolean | `true` | When enforced, allow runs with no runtime/provider/model identity. Set `false` only for strict host coverage. |
| `runtimeCoverage.blockedRuntimeIds` | string[] | `[]` | Optional runtime ids to block before inference when strict tool coverage is required. |
| `runtimeCoverage.blockedProviderIds` | string[] | `[]` | Optional provider ids to block before inference when strict tool coverage is required. |
| `runtimeCoverage.message` | string | built-in block text | Operator-facing block message for strict runtime-coverage blocks. |
| `reflection.enabled` | boolean | `false` | **Opt-in.** Master switch for the built-in reflective deliberation (below). Needs `allowConversationAccess`. |
| `reflection.reviewRoles` | string[] | `[]` | Extra review lenses to include — any of `critic`, `verifier`, `security`, `fact_checker`, `memory_curator`. |
| `reflection.maxAttempts` | integer ≥ 1 | `1` | How many times to ask the model to reflect before letting it finalize. |

The default install needs **no** `config` and **no** `hooks` permissions — just
the approval gate. The block below shows a fully opted-in setup:

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

> **Permissions are only required for the opt-in layers.** OpenClaw gates
> `before_prompt_build` behind `allowPromptInjection`, and `before_agent_run` /
> `before_agent_finalize` behind `allowConversationAccess`. Each layer registers
> only when you both enable it in `config` and grant its permission; a
> deliberately-off layer never claims a permissioned hook. The `before_tool_call`
> approval gate needs neither. See OpenClaw's
> [plugin permission docs](https://docs.openclaw.ai/plugins/plugin-permission-requests).

## Reflective Deliberation (opt-in)

When enabled (`reflection.enabled: true` + `allowConversationAccess`), and with
**no** external runtime, the plugin makes the agent *contemplate before it
finalizes*. On the agent's first attempt to declare it is done, the
`before_agent_finalize` hook returns one `revise` that asks the model to:

1. restate the active goal in one sentence,
2. state the concrete evidence that it is actually done,
3. if it is not fully done, name at least one **next right thing** and do it, and
4. self-review through the configured review lenses (`critic`, `verifier`, …).

It is a **one-shot** (`reflection.maxAttempts: 1` with a stable idempotency key), so it
asks once and then lets finalize proceed — never an infinite loop. Because it is off by
default, the finalize hook is registered only when you enable reflection (or wire an
audit, below); that is a startup decision, so a per-call `event.context.pluginConfig`
override can disable or tune reflection for a turn but cannot re-enable it when it is
globally off. If you wire a `loadCompletionAudit` callback (see
`plugin-entry.example.ts`), the finalize hook also registers, and an evidence-based audit
`revise` takes precedence over the built-in reflection; the two use distinct idempotency
keys.

## Autonomous operation (optional)

The plugin keeps each turn honest but does not *drive* the agent — OpenClaw acts only when
prompted. For an agent that **keeps doing the next right thing on its own**, the optional
[`heartbeat/`](heartbeat/README.md) companion periodically prompts your gateway from a layered
goal model (mission + backlog + recent context), with this plugin gating risk on every turn it
triggers. It ships idle and dry-run by default. See [`heartbeat/README.md`](heartbeat/README.md).

> The heartbeat is a **separate package** (`@next-right-thing/heartbeat`), not part of this
> plugin's hook runtime. It is a client of the OpenClaw gateway, with its own README, tests,
> and service templates, vendored here for convenience. You can run the plugin without it, and
> it can be extracted to its own repository without touching the plugin.

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
