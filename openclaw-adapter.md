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

The shipped entry (`index.js`) registers `before_tool_call` and `before_agent_finalize` (the latter is on by default for built-in reflective deliberation). `after_tool_call` and `agent_end` are documented integration points but are **not** registered by the default entry.

- `before_tool_call` (registered): infer side effects from the tool call and request approval for production mutation, destructive operations, publishing, messaging, auth changes, billing changes, or security exposure. Side-effect inference scans both the command string and the serialized tool params, so it catches:
  - destructive shell commands such as recursive-force deletes, hard resets, forced cleans, forced pushes, recursive PowerShell removal, and DELETE HTTP requests;
  - destructive SQL (`DROP TABLE/DATABASE/SCHEMA`, `DELETE FROM`, `TRUNCATE`) on database- and exec-like tools (so MCP database tools that carry SQL in params are gated, while a tool merely mentioning SQL as text is not);
  - commands hidden in object-valued `input`/`script` payloads or split into `args`/`argv` arrays;
  - secret-shaped values in any tool params (not only shell commands).
- `before_agent_finalize` (registered by default; **requires** `hooks.allowConversationAccess: true` on the plugin entry, since OpenClaw gates this hook behind conversation access): impose deliberation before the agent finalizes. With **no** external runtime, built-in *reflective deliberation* returns one `revise` asking the model to restate the goal, prove it is actually done, name the next right thing if not, and self-review through the configured review lenses — a one-shot guarded by `reflection.maxAttempts` (default 1) and a stable idempotency key. When `loadCompletionAudit` is also supplied, an evidence-based audit `revise` is checked first and takes precedence; the audit and reflection paths use **distinct** idempotency keys (`next-right-thing-completion-audit` vs `next-right-thing-reflection`) so the host never conflates them. Disable via `reflection.enabled: false`.
- `after_tool_call` (not registered): wire as observation-only if the host routes tool results into `runtime/nrt_supervisor.py evidence`.
- `agent_end` (not registered): wire to flush audit logs, call `nrt scheduler run-due`, or run `nrt reviews run` for deterministic review gates when native subagents were not used.

Approval prompts are deliberately bounded for OpenClaw approval surfaces:

- title: action-focused and short.
- description: capped at 256 characters.
- allowed decisions: `allow-once` and `deny`.
- timeout behavior: deny by default.
- no secrets or private payloads in approval text.

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

If the audit returns `status: "incomplete"`, the adapter emits a `before_agent_finalize` revise decision that tells the model what evidence is still missing. This composes with the built-in reflection: the audit is checked first and an audit `revise` wins; if the audit is complete (or no loader is wired), the built-in reflective deliberation runs instead. The two never double-revise on the same attempt and carry distinct idempotency keys.

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
