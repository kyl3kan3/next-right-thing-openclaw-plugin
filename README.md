# Next Right Thing OpenClaw Plugin

A dependency-free OpenClaw hook plugin whose **core is one reactive guardrail**: a
`before_tool_call` **approval gate** that pauses for human approval before risky or
irreversible actions (destructive shell, destructive SQL, production deploys, secret
exposure). It can also block a call flagged as not moving the active goal forward when a
host supplies that `moves_goal` signal, though the default entry infers risk effects only.
It **wraps prepared turns and never drives the agent** — a plain install registers only the
gate and needs no extra permission grant.

Three **optional layers are opt-in** (all default **off**), each turning on one additional
hook when you ask for it:

- `reflection.enabled` → a `before_agent_finalize` completion check (the no-runtime fallback
  for a wired `loadCompletionAudit`);
- `runContext.enabled` → a `before_prompt_build` model-agnostic run-context injector;
- `runtimeCoverage.enforce` → a `before_agent_run` runtime-coverage preflight.

## Install

```bash
openclaw plugins install git:github.com/kyl3kan3/next-right-thing-openclaw-plugin@main
openclaw plugins enable next-right-thing
openclaw gateway restart
openclaw plugins inspect next-right-thing --runtime --json
```

> **Version note:** the opt-in defaults this page describes (only `before_tool_call`
> registered out of the box; `reflection` / `runContext` / `runtimeCoverage` off) live on
> **`@main`**, which is why the commands here pin `@main`. The last tagged release
> `@v0.3.4-openclaw` predates this refocus and still registers the finalize/run-context/
> coverage hooks by default; a new tag will follow.

The approval gate works out of the box — **no extra permission grant required**. A plain
install registers only `before_tool_call`.

> **Only if you opt into the layers above:** OpenClaw gates the extra hooks behind
> operator-granted permissions. Add the ones you actually enable — `allowConversationAccess`
> for `reflection.enabled` (`before_agent_finalize`) **and** for `runtimeCoverage.enforce`
> (`before_agent_run`, a raw-conversation hook), and `allowPromptInjection` for
> `runContext.enabled` (`before_prompt_build`):
>
> ```json
> { "plugins": { "entries": { "next-right-thing": {
>   "hooks": { "allowConversationAccess": true, "allowPromptInjection": true }
> } } } }
> ```
>
> Skip this entirely for a gate-only install. See [Configuration](#configuration).

## Smoke Test

On the OpenClaw host, run the packaged verification script:

```bash
curl -fsSL -o /tmp/verify-openclaw-install.sh https://raw.githubusercontent.com/kyl3kan3/next-right-thing-openclaw-plugin/main/scripts/verify-openclaw-install.sh
bash /tmp/verify-openclaw-install.sh
```

For CLI-level smoke tests, use a healthy Gateway or force the embedded local
runner with `openclaw agent --local --json ...`. If a JSON result reports
`meta.fallbackFrom: "gateway"`, the Gateway request failed and OpenClaw used an
automatic fallback path; restart the Gateway and rerun before treating the smoke
as evidence of hook coverage.

### Runtime and native shell safety

`before_tool_call` (always on) wraps OpenClaw-owned dynamic tools that reach the
hook surface — this is the core gate.

When opted in, `before_prompt_build` (`runContext.enabled`) injects the Next Right
Thing operating context for any model that reaches OpenClaw's hook runner, and
`before_agent_run` (`runtimeCoverage.enforce`) is a preflight that proves the plugin
layer was invoked before inference; even when enforced it is model-agnostic and does
**not** block Claude CLI, Anthropic, OpenAI, or unidentified runtimes merely because
of their model/provider id.

If you need strict host-level tool coverage, enable the preflight and configure
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
`before_tool_call` approval gate (the always-on core; it reports which optional
layers are active without requiring them). It also fails when it sees
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
of executing directly. If you opted into `runContext`, the model also receives the
Next Right Thing run context; if you enabled strict `runtimeCoverage` blocking,
matching runtime or provider ids are blocked before inference.

## Configuration

Config knobs are set under the plugin's entry in your OpenClaw config:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `approvalTimeoutMs` | integer (ms) | `60000` | How long to wait for an approval decision before denying. Times out to **deny** (fail-safe). |
| `runContext.enabled` | boolean | `false` | **Opt-in.** Inject the model-agnostic Next Right Thing operating context with `before_prompt_build` (requires `allowPromptInjection`). |
| `runContext.instruction` | string | built-in NRT context | Optional replacement for the default run-context instruction. |
| `runtimeCoverage.enforce` | boolean | `false` | **Opt-in.** Register the `before_agent_run` preflight (requires `allowConversationAccess`). |
| `runtimeCoverage.allowUnidentifiedRuntime` | boolean | `true` | Allow runs when OpenClaw provides no runtime/provider/model identity. Set `false` only for strict host coverage. |
| `runtimeCoverage.blockedRuntimeIds` | string[] | `[]` | Optional runtime ids to block before inference when strict tool coverage is required. |
| `runtimeCoverage.blockedProviderIds` | string[] | `[]` | Optional provider ids to block before inference when strict tool coverage is required. |
| `runtimeCoverage.message` | string | built-in block text | Operator-facing block message for strict runtime-coverage blocks. |
| `reflection.enabled` | boolean | `false` | **Opt-in.** Built-in reflective deliberation (the no-runtime fallback for `loadCompletionAudit`; requires `allowConversationAccess`). |
| `reflection.reviewRoles` | string[] | `[]` | Extra review lenses to include — any of `critic`, `verifier`, `security`, `fact_checker`, `memory_curator`. |
| `reflection.maxAttempts` | integer ≥ 1 | `1` | How many times to ask the model to reflect before letting it finalize. |

A gate-only install needs no `config` block at all. Below is an "everything opted in" example
(turn on only the layers you actually want):

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

> **Permissions are needed only for the layers you enable.** OpenClaw gates
> `before_prompt_build` behind `allowPromptInjection` (`runContext.enabled`), and
> `before_agent_run` (`runtimeCoverage.enforce`) plus `before_agent_finalize` behind
> `allowConversationAccess`. The finalize hook registers when **either** `reflection.enabled`
> is set **or** a `loadCompletionAudit` loader is wired — so the preferred evidence-audit
> path needs `allowConversationAccess` too. Add only the grant(s) for what you turn on; a
> gate-only install needs none. See
> OpenClaw's [plugin permission docs](https://docs.openclaw.ai/plugins/plugin-permission-requests).

## Completion check & reflective deliberation (opt-in)

The second guardrail keeps the agent from claiming "done" prematurely. It is **off by default**;
turn it on either way (both register `before_agent_finalize`):

- **Evidence audit (preferred):** wire a `loadCompletionAudit` callback (see `plugin-entry.example.ts`).
  On finalize it inspects your real completion evidence and returns a `revise` listing what is unproven.
- **Built-in reflection (no-runtime fallback):** set `reflection.enabled: true`. On the agent's first
  finalize attempt the hook returns one `revise` asking the model to (1) restate the active goal,
  (2) state the concrete evidence it is done, (3) if not, name the **next right thing** and do it, and
  (4) self-review through the configured lenses (`critic`, `verifier`, …).

The reflection is a **one-shot** (`reflection.maxAttempts: 1` + stable idempotency key) — it asks once,
then lets finalize proceed, never a loop. Whether the hook is registered is a startup decision (audit
wired, or `reflection.enabled: true`), so a per-call override can disable/tune it but cannot resurrect it
when off. When both are wired, the evidence audit `revise` outranks the built-in reflection; they use
distinct idempotency keys and never double-revise.

## Autonomous operation (separate companion)

This plugin is a **reactive guardrail** — it wraps prepared turns and never drives the agent. If you also
want something that *drives* an agent to keep acting on its own, that is a **different tool**: the optional
[`heartbeat/`](heartbeat/README.md) companion in this repo is a standalone gateway client (not a hook, not
part of the plugin runtime) that periodically prompts your gateway from a layered goal model, with this
plugin gating risk on every turn it triggers. It ships idle and dry-run by default and is intended to be
extracted into its own package. See [`heartbeat/README.md`](heartbeat/README.md).

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
