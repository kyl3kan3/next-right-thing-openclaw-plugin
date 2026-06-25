# Next Right Thing OpenClaw Plugin

OpenClaw hook plugin for the Next Right Thing protocol.

It adds approval gates around risky tool calls and a completion-audit hook surface for agents that should keep moving while preserving evidence, verification, and safety.

## Install

```bash
openclaw plugins install git:github.com/kyl3kan3/next-right-thing-openclaw-plugin@v0.2.2-openclaw
openclaw plugins enable next-right-thing
openclaw gateway restart
openclaw plugins inspect next-right-thing --runtime --json
```

## Smoke Test

Ask OpenClaw to run a safe command first:

```text
Run: npm test
```

Then test a gated action:

```text
Run: vercel deploy --prod
```

Expected result: OpenClaw asks for approval instead of executing directly.

## Configuration

The plugin exposes one config knob, set under the plugin's entry in your
OpenClaw config:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `approvalTimeoutMs` | integer (ms) | `60000` | How long to wait for an approval decision before denying. Times out to **deny** (fail-safe). |

```json
{ "plugins": { "entries": { "next-right-thing": { "config": { "approvalTimeoutMs": 60000 } } } } }
```

Out of the box only the `before_tool_call` approval gate is active. The
`before_agent_finalize` completion-audit gate activates only when you wire a
`loadCompletionAudit` function (see `plugin-entry.example.ts`), which depends on
the Next Right Thing Python runtime.

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
