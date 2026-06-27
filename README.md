# Next Right Thing OpenClaw Plugin

A single, dependency-free OpenClaw hook plugin with **two reactive guardrails**:

1. **`before_tool_call` — an approval gate** that pauses for human approval before risky or
   irreversible actions (destructive shell, destructive SQL, production deploys, secret exposure)
   and blocks calls that do not move the active goal forward.
2. **`before_agent_finalize` — a completion check** that won't let the agent claim "done" without
   proven evidence (via a wired `loadCompletionAudit`, with an optional built-in reflection fallback).

It **wraps prepared turns and never drives the agent** — it restrains, it does not push. (For an
optional autonomous *driver*, see the separate [`heartbeat/`](#autonomous-operation-separate-companion)
companion below — it is deliberately not part of the plugin's hook runtime.)

## Install

```bash
openclaw plugins install git:github.com/kyl3kan3/next-right-thing-openclaw-plugin@v0.3.4-openclaw
openclaw plugins enable next-right-thing
openclaw gateway restart
openclaw plugins inspect next-right-thing --runtime --json
```

> Installs the current stable release. To test unreleased changes instead, replace
> the tag with `@main`.

The approval gate works out of the box — **no extra permission grant required**. A plain install
registers only `before_tool_call`, so there is nothing to enable.

> **Only if you opt into the finalize check** (`reflection.enabled: true`, or a wired
> `loadCompletionAudit`): OpenClaw gates `before_agent_finalize` behind an operator-granted
> permission, so add `hooks.allowConversationAccess: true` once. Skip this for a gate-only install.
> See [Configuration](#configuration).

## Smoke Test

On the OpenClaw host, run the packaged verification script:

```bash
curl -fsSL -o /tmp/verify-openclaw-install.sh https://raw.githubusercontent.com/kyl3kan3/next-right-thing-openclaw-plugin/v0.3.4-openclaw/scripts/verify-openclaw-install.sh
bash /tmp/verify-openclaw-install.sh
```

### Required for Claude CLI/native shell safety

`before_tool_call` wraps OpenClaw-owned dynamic tools. On OpenClaw setups where
an external runtime owns native shell execution, such as Claude CLI, shell
commands are governed by OpenClaw's native exec policy. Do not leave that policy
in YOLO mode (`security=full`, `ask=off`) if you expect destructive shell
commands to be blocked.

Recommended baseline:

```bash
openclaw config patch --stdin <<'JSON'
{"tools":{"exec":{"security":"allowlist","ask":"on-miss","strictInlineEval":true}}}
JSON
openclaw gateway restart
```

If your agents have `agents.list[].tools.exec` overrides, set those overrides to
the same `security=allowlist`, `ask=on-miss`, and `strictInlineEval=true` values.
The verification script fails by default when it sees `security=full` plus
`ask=off`; set `REQUIRE_SAFE_EXEC_POLICY=0` only when you intentionally want to
test hook registration without hardening native exec.

Ask OpenClaw to run a safe command first:

```text
Run: npm test
```

Then test a gated action:

```text
Run: vercel deploy --prod
```

Expected result: OpenClaw-owned tools ask for a next-right-thing approval instead
of executing directly. Claude CLI/native shell commands should be blocked or
sent through OpenClaw's native exec approval policy unless explicitly approved.

## Configuration

Config knobs are set under the plugin's entry in your OpenClaw config:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `approvalTimeoutMs` | integer (ms) | `60000` | How long to wait for an approval decision before denying. Times out to **deny** (fail-safe). |
| `reflection.enabled` | boolean | `false` | **Opt-in.** Turns on the built-in reflective deliberation (below) — the no-runtime fallback for `loadCompletionAudit`. |
| `reflection.reviewRoles` | string[] | `[]` | Extra review lenses to include — any of `critic`, `verifier`, `security`, `fact_checker`, `memory_curator`. |
| `reflection.maxAttempts` | integer ≥ 1 | `1` | How many times to ask the model to reflect before letting it finalize. |

A gate-only install needs no `config` block at all. To opt into the finalize reflection:

```json
{ "plugins": { "entries": { "next-right-thing": {
  "hooks": { "allowConversationAccess": true },
  "config": {
    "approvalTimeoutMs": 60000,
    "reflection": { "enabled": true, "reviewRoles": ["security"] }
  }
} } } }
```

> **`hooks.allowConversationAccess` is required only when the finalize check is active**
> (`reflection.enabled: true` or a wired `loadCompletionAudit`). OpenClaw gates
> `before_agent_finalize` behind that conversation-access permission. A gate-only install never
> registers that hook, so it needs no grant. See OpenClaw's
> [plugin permission docs](https://docs.openclaw.ai/plugins/plugin-permission-requests).

## Completion check & reflective deliberation (opt-in)

The second guardrail keeps the agent from claiming "done" prematurely. There are two ways to wire it,
and **both are off until you turn them on**:

- **Evidence audit (preferred):** wire a `loadCompletionAudit` callback (see `plugin-entry.example.ts`).
  On finalize it inspects your real completion evidence and returns a `revise` listing what is unproven.
- **Built-in reflection (no-runtime fallback):** set `reflection.enabled: true`. On the agent's first
  finalize attempt the `before_agent_finalize` hook returns one `revise` asking the model to (1) restate
  the active goal, (2) state the concrete evidence it is done, (3) if not, name the **next right thing**
  and do it, and (4) self-review through the configured lenses (`critic`, `verifier`, …).

The reflection is a **one-shot** (`reflection.maxAttempts: 1` with a stable idempotency key) — it asks
once, then lets finalize proceed, never an infinite loop. Whether the finalize hook is registered at all
is a startup decision (audit wired, or `reflection.enabled: true`), so a per-call override can disable or
tune it but cannot resurrect it when off. When both are wired, the evidence audit `revise` outranks the
built-in reflection; they use distinct idempotency keys and never double-revise.

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
