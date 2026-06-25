# OpenClaw Adapter

The OpenClaw adapter uses plugin hooks rather than a new agent harness. OpenClaw's current docs describe harnesses as low-level executors for prepared turns, while hooks are the extension points for inspecting or changing agent runs, tool calls, message flow, session lifecycle, subagents, and Gateway startup.

The scaffold follows the native plugin split documented by OpenClaw:

- `openclaw.plugin.json` is static metadata and config validation.
- `package.json#openclaw.extensions` points OpenClaw at the runtime entrypoint.
- `index.ts` exports the default `definePluginEntry` object.
- `next-right-thing-hooks.mjs` stays dependency-free so it can be unit-tested without OpenClaw installed.

See OpenClaw's plugin manifest, entrypoint, and permission request docs:

- https://docs.openclaw.ai/plugins/manifest
- https://docs.openclaw.ai/plugins/sdk-entrypoints
- https://docs.openclaw.ai/plugins/plugin-permission-requests

## Files

- `next-right-thing-hooks.mjs`: dependency-free hook decision logic.
- `index.ts`: package-ready OpenClaw plugin entry.
- `plugin-entry.example.ts`: smaller example entry for embedding in another plugin.
- `package.json`: OpenClaw extension metadata for package or checkout loading.
- `openclaw.plugin.json`: native OpenClaw manifest with strict config schema.
- `fixtures/simulate-runtime.mjs`: local hook-registration fixture used by tests.

## Hook Mapping

- `before_tool_call`: infer side effects from the tool call and request approval for production mutation, destructive operations, publishing, messaging, auth changes, billing changes, or security exposure. Secret-shaped values in any tool params are treated as security exposure, not only shell commands.
- `before_agent_finalize`: optionally load the supervisor completion audit and request one more model pass when completion is not proven.
- `after_tool_call`: leave as observation-only unless the host routes tool results into `runtime/nrt_supervisor.py evidence`.
- `agent_end`: leave as observation-only or use it to flush audit logs, call `nrt scheduler run-due`, or run `nrt reviews run` for deterministic review gates when native subagents were not used.

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
  index.ts
  next-right-thing-hooks.mjs
  openclaw.plugin.json
  package.json
```

`index.ts`, `openclaw.plugin.json`, and `package.json#openclaw.extensions` must all use the same plugin id and entry path.

## Completion Audit

Wire `loadCompletionAudit` to the Python supervisor:

```bash
python runtime/nrt_supervisor.py audit --state .nrt/openclaw-session.json
```

If the audit returns `status: "incomplete"`, the adapter emits a `before_agent_finalize` revise decision that tells the model what evidence is still missing.

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
node --test tests/test_openclaw_adapter.mjs
```

That test covers side-effect inference, approval prompt shape, manifest/package metadata agreement, and the `fixtures/simulate-runtime.mjs` hook fixture. Run the OpenClaw CLI validator from your installed OpenClaw version as the final check when packaging it for a real OpenClaw setup.

## Why This Is Not a Harness

Do not register this as an OpenClaw agent harness unless you are replacing the native session runtime. The protocol is host policy: goal state, approvals, verification, and memory proposals should wrap prepared turns rather than own provider/model selection.
