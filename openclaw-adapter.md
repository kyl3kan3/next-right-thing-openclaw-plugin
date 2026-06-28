# OpenClaw Adapter

The OpenClaw adapter uses plugin hooks rather than a new agent harness. OpenClaw's current docs describe harnesses as low-level executors for prepared turns, while hooks are the extension points for inspecting or changing agent runs, tool calls, message flow, session lifecycle, subagents, and Gateway startup.

The scaffold follows the native plugin split documented by OpenClaw:

- `openclaw.plugin.json` is static metadata and config validation.
- `package.json#openclaw.extensions` points OpenClaw at the compiled JavaScript runtime entrypoint.
- `index.js` exports the default `definePluginEntry` object for git/npm installs.
- `index.ts` is kept as the TypeScript source equivalent for local development.
- `next-right-thing-hooks.mjs` stays dependency-free so it can be unit-tested without OpenClaw installed.

See OpenClaw's plugin manifest, entrypoint, and permission request docs:

- https://docs.openclaw.ai/plugins/manifest
- https://docs.openclaw.ai/plugins/sdk-entrypoints
- https://docs.openclaw.ai/plugins/plugin-permission-requests

## Files

- `next-right-thing-hooks.mjs`: dependency-free hook decision logic.
- `index.js`: package-ready OpenClaw plugin entry.
- `index.ts`: TypeScript source equivalent.
- `plugin-entry.example.ts`: smaller example entry for embedding in another plugin.
- `package.json`: OpenClaw extension metadata for package or checkout loading.
- `openclaw.plugin.json`: native OpenClaw manifest with strict config schema.
- `fixtures/simulate-runtime.mjs`: local hook-registration fixture used by tests.

## Hook Mapping

The shipped entry (`index.js`) always registers `before_tool_call` (the approval gate — the
always-on core). Three optional hooks register **only when opted into** (all default off):
`before_prompt_build` (`runContext.enabled`), `before_agent_run` (`runtimeCoverage.enforce`),
and `before_agent_finalize` (`reflection.enabled` or a wired `loadCompletionAudit`).
`after_tool_call` and `agent_end` are documented integration points but are **not** registered.

- `before_prompt_build` (opt-in via `runContext.enabled`; **requires** `hooks.allowPromptInjection: true`): inject the model-agnostic Next Right Thing operating context into the system prompt, so any model that reaches OpenClaw's hook runner is told to pick the smallest useful next step, preserve evidence, use OpenClaw-covered tools for risky operations, and prove completion before finalizing. Replace the text via `runContext.instruction`.
- `before_agent_run` (opt-in via `runtimeCoverage.enforce`; **requires** `hooks.allowConversationAccess: true`): preflight that proves the NRT plugin layer was invoked before inference. Even when enforced it is model-agnostic and passes Claude CLI, Anthropic, OpenAI, and unidentified runtimes. Operators can opt into strict blocking with `runtimeCoverage.blockedRuntimeIds`, `runtimeCoverage.blockedProviderIds`, or `runtimeCoverage.allowUnidentifiedRuntime: false`; blocks return `category: "runtime_coverage"`.
- `before_tool_call` (registered): infer side effects from OpenClaw-owned dynamic tool calls and request approval for production mutation, destructive operations, publishing, messaging, auth changes, billing changes, or security exposure. Side-effect inference scans both the command string and the serialized tool params, so it catches:
  - destructive shell commands such as recursive-force deletes, hard resets, forced cleans, forced pushes, recursive PowerShell removal, and DELETE HTTP requests;
  - destructive SQL (`DROP TABLE/DATABASE/SCHEMA`, `DELETE FROM`, `TRUNCATE`) on database- and exec-like tools (so MCP database tools that carry SQL in params are gated, while a tool merely mentioning SQL as text is not);
  - commands hidden in object-valued `input`/`script` payloads or split into `args`/`argv` arrays;
  - secret-shaped values in any tool params (not only shell commands).
- `before_agent_finalize` (opt-in; registered only when `reflection.enabled: true` or a `loadCompletionAudit` loader is wired; then **requires** `hooks.allowConversationAccess: true`): impose a completion check before the agent finalizes. Preferred path is an evidence-based `loadCompletionAudit` `revise` listing what is unproven. As a no-runtime fallback, `reflection.enabled: true` returns one `revise` asking the model to restate the goal, prove it is actually done, name the next right thing if not, and self-review through the configured review lenses — a one-shot guarded by `reflection.maxAttempts` (default 1) and a stable idempotency key. When both are wired, the audit `revise` is checked first and takes precedence; the audit and reflection paths use **distinct** idempotency keys (`next-right-thing-completion-audit` vs `next-right-thing-reflection`). A plain install opts into neither, so this hook is not registered and no conversation-access grant is needed.
- `after_tool_call` (not registered): wire as observation-only if the host routes tool results into `runtime/nrt_supervisor.py evidence`.
- `agent_end` (not registered): wire to flush audit logs, call `nrt scheduler run-due`, or run `nrt reviews run` for deterministic review gates when native subagents were not used.

Approval prompts are deliberately bounded for OpenClaw approval surfaces:

- title: action-focused and short.
- description: capped at 256 characters.
- allowed decisions: `allow-once` and `deny`.
- timeout behavior: deny by default.
- no secrets or private payloads in approval text.

### Native runtime boundary

OpenClaw runtimes that own their own native shell tools must route those calls
through the gateway/native relay before plugin `before_tool_call` can see them.
On OpenClaw 2026.6.10, the Codex app-server harness exposes that bridge through
`openclaw hooks relay`; configure exec with `tools.exec.host="gateway"` so native
Codex `PreToolUse` events can reach the same NRT approval gate as
OpenClaw-owned dynamic tools. By default these models run under the approval gate
only — they receive the model-wide NRT **prompt context** solely when you opt in
with `runContext.enabled: true` (plus `hooks.allowPromptInjection`). The plugin
does not hard-block a model just because it is Claude CLI or another CLI backend.

If you require hard host-level tool coverage, configure strict
`runtimeCoverage` blocking for the relevant runtime/provider ids, or require
runtime identity with `allowUnidentifiedRuntime: false`. In all cases, keep
`tools.exec.host=gateway`, `tools.exec.security=allowlist`,
`tools.exec.ask=on-miss`, and `tools.exec.strictInlineEval=true` or stricter,
and apply the same values to any `agents.list[].tools.exec` overrides. If the
effective policy remains local/native or `security=full` and `ask=off`,
destructive native CLI shell commands can execute without `before_tool_call`
seeing them.

When testing through `openclaw agent --json`, do not count a result with
`meta.fallbackFrom: "gateway"` as coverage evidence. That means the Gateway
request failed and OpenClaw used an automatic embedded fallback path; restart the
Gateway or force `--local` and rerun the smoke.

## Minimal Use

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createNextRightThingPlugin } from "./next-right-thing-hooks.mjs";

export default createNextRightThingPlugin(definePluginEntry, {
  pluginId: "next-right-thing",
});
```

For a package-ready plugin, keep these files in the same plugin root:

```text
adapters/openclaw/
  index.js
  index.ts
  next-right-thing-hooks.mjs
  openclaw.plugin.json
  package.json
```

`index.js`, `openclaw.plugin.json`, and `package.json#openclaw.extensions` must all use the same plugin id and entry path.

## Completion Audit

Wire `loadCompletionAudit` to the Python supervisor:

```bash
python runtime/nrt_supervisor.py audit --state .nrt/openclaw-session.json
```

If the audit returns `status: "incomplete"`, the adapter emits a `before_agent_finalize` revise decision that tells the model what evidence is still missing. This composes with the built-in reflection **only when you opt into it** (`reflection.enabled: true`): the audit is checked first and an audit `revise` wins; if the audit is complete (or no loader is wired) **and** `reflection.enabled: true`, the built-in reflective deliberation runs instead. With neither a `loadCompletionAudit` loader nor `reflection.enabled`, the `before_agent_finalize` hook is not registered and no completion check runs at all. When both run, they never double-revise on the same attempt and carry distinct idempotency keys.

## Runtime Sidecar Commands

Use these commands around OpenClaw hooks when the Python runtime is installed:

```bash
nrt policy validate --state .nrt/state.json
nrt reviews run --state .nrt/state.json --jobs .nrt/reviews --project . --security-output .nrt/security-scan.json --audit --force
nrt scheduler run-due --state .nrt/state.json
nrt supervisor audit-log --state .nrt/state.json
nrt benchmark
```

Use OpenClaw-native subagents when available. Use `nrt reviews run` when you need a deterministic CI/local gate or a fallback reviewer path.

## Local Validation

The repository validates this adapter without requiring an OpenClaw install:

```bash
npm test        # or: node --test
```

`tests/hooks.test.mjs` covers side-effect inference (destructive shell, SQL, production, publish, secrets), approval prompt shape, severity, config threading, the `moves_goal` block path, and the `fixtures/simulate-runtime.mjs` hook fixture. Run the OpenClaw CLI validator from your installed OpenClaw version as the final check when packaging it for a real OpenClaw setup.

## Why This Is Not a Harness

Do not register this as an OpenClaw agent harness unless you are replacing the native session runtime. The protocol is host policy: goal state, approvals, verification, and memory proposals should wrap prepared turns rather than own provider/model selection.
