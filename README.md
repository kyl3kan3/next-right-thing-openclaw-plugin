# Next Right Thing OpenClaw Plugin

OpenClaw hook plugin for the Next Right Thing protocol.

It adds approval gates around risky tool calls and a completion-audit hook surface for agents that should keep moving while preserving evidence, verification, and safety.

## Install

```bash
openclaw plugins install git:github.com/kyl3kan3/next-right-thing-openclaw-plugin@v0.2.0-openclaw
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

## Local Validation

From the full Next Right Thing source tree:

```bash
node --test tests/test_openclaw_adapter.mjs
python runtime/nrt_security_scan.py --path adapters/openclaw --fail-on high
```

