# Next Right Thing — OpenClaw Plugin

[![test](https://github.com/kyl3kan3/next-right-thing-openclaw-plugin/actions/workflows/test.yml/badge.svg)](https://github.com/kyl3kan3/next-right-thing-openclaw-plugin/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](package.json)
[![node: ≥20](https://img.shields.io/badge/node-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](package.json)
[![red-team catch-rate: 100%](https://img.shields.io/badge/red--team%20catch--rate-100%25-brightgreen.svg)](bench/)

> A safety guardrail for [OpenClaw](https://openclaw.ai) agents: it pauses risky or
> irreversible tool calls for human approval **before** they run.

`next-right-thing` is a dependency-free OpenClaw **hook** plugin. It is *host policy* —
it wraps prepared agent turns and gates what an agent does. It deliberately does **not**
choose models or providers, and it is **not** an agent harness.

Install it and you get one thing: an always-on approval gate that needs no configuration
and no special permissions. Three optional layers add deeper checks when you ask for them.

## Hooks at a glance

| Hook | Default | Permission | What it does |
| --- | :---: | --- | --- |
| **`before_tool_call`** — approval gate | ✅ always on | none | Infers side effects (destructive shell/SQL, production deploys, secret exposure, …) and requests **bounded human approval** before risky calls. *This is the product.* |
| **`before_agent_finalize`** — completion check | ⬜ opt-in | `allowConversationAccess` | Won't let the agent claim "done" without proof — via a wired `loadCompletionAudit`, or built-in reflection. |
| **`before_prompt_build`** — run context | ⬜ opt-in | `allowPromptInjection` | Injects a model-agnostic "next right thing" operating context into every prompt. |
| **`before_agent_run`** — runtime coverage | ⬜ opt-in | `allowConversationAccess` | Preflight that can block runs from uncovered runtimes/providers. |

A plain install registers **only** `before_tool_call`. The other three stay off until you
both enable them in `config` and grant the hook permission OpenClaw gates them behind.

## Quick start

```bash
openclaw plugins install git:github.com/kyl3kan3/next-right-thing-openclaw-plugin@v0.3.4-openclaw
openclaw plugins enable next-right-thing
openclaw gateway restart
openclaw plugins inspect next-right-thing --runtime --json
```

> Installs the latest tagged release. To try unreleased changes, replace the tag with `@main`.

That is all the core gate needs. To see it work, ask the agent to run a safe command, then a
risky one:

```text
Run: npm test            # runs normally
Run: vercel deploy --prod # prompts for approval first
```

OpenClaw-owned tools now surface a Next Right Thing approval prompt instead of executing
directly.

## Configuration

Config knobs live under the plugin's entry in your OpenClaw config. **A gate-only install
needs no `config` and no `hooks` permissions.**

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `approvalTimeoutMs` | integer (ms) | `60000` | How long to wait for an approval decision before denying. Times out to **deny** (fail-safe). |
| `runContext.enabled` | boolean | `false` | **Opt-in.** Inject the model-agnostic operating context via `before_prompt_build`. Needs `allowPromptInjection`. |
| `runContext.instruction` | string | built-in | Optional replacement for the default run-context instruction. |
| `runtimeCoverage.enforce` | boolean | `false` | **Opt-in.** Register the `before_agent_run` preflight. Needs `allowConversationAccess`. |
| `runtimeCoverage.allowUnidentifiedRuntime` | boolean | `true` | When enforced, allow runs with no runtime/provider/model identity. Set `false` for strict host coverage. |
| `runtimeCoverage.blockedRuntimeIds` | string[] | `[]` | Runtime ids to block before inference. |
| `runtimeCoverage.blockedProviderIds` | string[] | `[]` | Provider ids to block before inference. |
| `runtimeCoverage.message` | string | built-in | Operator-facing message for runtime-coverage blocks. |
| `reflection.enabled` | boolean | `false` | **Opt-in.** Built-in reflective deliberation on finalize (below). Needs `allowConversationAccess`. |
| `reflection.reviewRoles` | string[] | `[]` | Extra review lenses: `critic`, `verifier`, `security`, `fact_checker`, `memory_curator`. |
| `reflection.maxAttempts` | integer ≥ 1 | `1` | How many times to ask the model to reflect before finalizing. |

A fully opted-in setup looks like this:

```json
{
  "plugins": {
    "entries": {
      "next-right-thing": {
        "hooks": { "allowPromptInjection": true, "allowConversationAccess": true },
        "config": {
          "approvalTimeoutMs": 60000,
          "runContext": { "enabled": true },
          "runtimeCoverage": { "enforce": true, "allowUnidentifiedRuntime": true },
          "reflection": { "enabled": true, "reviewRoles": ["security"] }
        }
      }
    }
  }
}
```

> **Permissions apply only to the opt-in layers.** OpenClaw gates `before_prompt_build`
> behind `allowPromptInjection`, and `before_agent_run` / `before_agent_finalize` behind
> `allowConversationAccess`. Each layer registers only when you both enable it in `config`
> and grant its permission — a deliberately-off layer never claims a permissioned hook, and
> the `before_tool_call` gate needs neither. See OpenClaw's
> [plugin permission docs](https://docs.openclaw.ai/plugins/plugin-permission-requests).

## Completion check & reflection (opt-in)

The second guardrail stops the agent from declaring "done" prematurely. It is off by default;
enable it either way — both register `before_agent_finalize`:

- **Evidence audit (preferred).** Wire a `loadCompletionAudit` callback (see
  [`plugin-entry.example.ts`](plugin-entry.example.ts)). On finalize it inspects your real
  completion evidence and returns a `revise` listing what is still unproven.
- **Built-in reflection (no-runtime fallback).** Set `reflection.enabled: true`. On the
  agent's first finalize attempt the hook returns one `revise` asking the model to:
  1. restate the active goal in one sentence,
  2. state the concrete evidence that it is done,
  3. if it is not, name at least one **next right thing** and do it,
  4. self-review through the configured lenses (`critic`, `verifier`, …).

The reflection is a **one-shot** (`maxAttempts: 1` with a stable idempotency key) — it asks
once, then lets finalize proceed; it can never loop. When both paths are wired, the evidence
audit takes precedence; the two use distinct idempotency keys and never double-revise.

## Autonomous operation (optional)

The plugin keeps each turn honest but never *drives* the agent — OpenClaw acts only when
prompted. For an agent that keeps acting on its own, the optional
[`heartbeat/`](heartbeat/README.md) companion periodically prompts your gateway from a layered
goal model (mission + backlog + recent context), with this plugin gating risk on every turn it
triggers. It ships **idle and dry-run by default**.

> The heartbeat is a **separate package** (`@next-right-thing/heartbeat`), not part of this
> plugin's hook runtime — a gateway client with its own README, tests, and service templates,
> vendored here for convenience. The plugin runs fine without it.

## Verifying your install & hardening native exec

The core gate covers OpenClaw-owned dynamic tools. Native shell execution (e.g. a Claude CLI
or Codex app-server backend) is governed by OpenClaw's own exec policy — so for full coverage,
route exec through the gateway and keep that policy out of YOLO mode.

<details>
<summary><b>Run the packaged verification script</b></summary>

On the OpenClaw host:

```bash
curl -fsSL -o /tmp/verify-openclaw-install.sh \
  https://raw.githubusercontent.com/kyl3kan3/next-right-thing-openclaw-plugin/v0.3.4-openclaw/scripts/verify-openclaw-install.sh
bash /tmp/verify-openclaw-install.sh
```

The script **requires only the `before_tool_call` approval gate** (the always-on core) and
reports which opt-in layers are active without requiring them. Set `REQUIRE_RUN_CONTEXT=1` or
`REQUIRE_RUNTIME_COVERAGE=1` to require those layers once you have enabled them. It also fails
when the exec policy is unsafe (`security=full` + `ask=off`), when `tools.exec.host` is not
`gateway`, when `strictInlineEval` is off, or when `openclaw hooks relay` is unavailable —
override with `REQUIRE_SAFE_EXEC_POLICY=0`, `REQUIRE_GATEWAY_EXEC_HOST=0`, or
`REQUIRE_NATIVE_HOOK_RELAY=0` for registration-only checks.

For CLI smoke tests, use a healthy gateway or force the embedded runner with
`openclaw agent --local --json …`. A result with `meta.fallbackFrom: "gateway"` means the
gateway request failed and OpenClaw fell back — restart the gateway and rerun before trusting it.

</details>

<details>
<summary><b>Recommended native-exec hardening</b></summary>

```bash
openclaw config patch --stdin <<'JSON'
{"tools":{"exec":{"host":"gateway","security":"allowlist","ask":"on-miss","strictInlineEval":true}}}
JSON
openclaw gateway restart
```

Apply the same `host=gateway`, `security=allowlist`, `ask=on-miss`, `strictInlineEval=true`
values to any `agents.list[].tools.exec` overrides. On OpenClaw 2026.6.10 the Codex app-server
harness bridges native `PreToolUse` / `PostToolUse` / `Stop` callbacks into OpenClaw via
`openclaw hooks relay`; that relay is what lets native shell calls reach the same
`before_tool_call` policy. If exec stays on a local/native host or YOLO policy, destructive
shell commands can run without this plugin's approval prompt.

</details>

## Scope & non-goals

This plugin is intentionally narrow — host policy that wraps prepared turns.

- **In scope:** the `before_tool_call` approval gate (always on) and the three opt-in
  audit/shaping layers above.
- **Not in scope:** selecting models or providers, driving the agent, or acting as a harness.
- **Separate:** the [`heartbeat/`](heartbeat/README.md) continuation engine (its own package).
- **Out of this repository:** the Python Next Right Thing runtime
  (`nrt reviews`/`scheduler`/`supervisor`). This adapter is dependency-free; wire that source
  tree in via `loadCompletionAudit` only if you run it.

## Red-team coverage

The gate ships with a reproducible red-team benchmark (`bench/`) — a labelled corpus of
**35 malicious** tool calls that must be gated and **22 benign** calls that must not — run
through the exact `beforeToolCallDecision` entry point used in production:

```bash
npm run bench
```

Current, measured result:

| Metric | Result | Meaning |
| --- | :---: | --- |
| **Catch-rate** | **100%** (35/35) | every risky call — destructive shell/SQL, raw-disk wipes, pipe-to-shell (`curl … \| sh`), argv-split & nested payloads, production deploys, publishing, messaging, billing, secret exposure — is blocked or sent for approval. |
| **False-positive-rate** | **0%** (22/22) | ordinary safe work — reads, `SELECT`, `npm test`, a `\| ssh` pipe, SQL/shell keywords appearing only as *text* — passes untouched, so the gate never cries wolf. |

These thresholds are enforced in CI (`bench/bench.test.mjs`), so a change that lets a risky
call slip through — or starts gating safe work — fails the build. Extend the corpus in
[`bench/corpus.mjs`](bench/corpus.mjs); the number above is the honest count, not a claim.

## Development

The repository is self-contained and dependency-free — no install step is needed:

```bash
npm test    # or: node --test
```

`tests/hooks.test.mjs` covers side-effect inference (destructive shell, SQL, production,
publish, secrets), approval-prompt shape, severity, and config threading, against the
`fixtures/simulate-runtime.mjs` hook fixture. `bench/` adds the red-team catch-rate benchmark
above.

## License

[MIT](LICENSE)
