# Next-Right-Thing Heartbeat (optional companion)

The `next-right-thing` **plugin** keeps each agent turn honest, but OpenClaw is
request-driven — it only acts when prompted. This **heartbeat** is the missing
"continuation engine": a tiny, dependency-free runner that periodically asks your
gateway *"what's the next right thing right now? do it,"* so the agent keeps making
progress with no human in the loop. The plugin then gates risk and runs the finalize
reflection on every turn it triggers.

It is a **client of the gateway**, separate from the plugin's hook runtime. No npm
deps; runs with plain `node`.

## The goal model (three layers, one prompt)

Each tick composes a single prompt from three files in `state/` — empty layers drop out:

- **`state/mission.md`** — your standing north-star goal.
- **`state/queue.json`** — an ordered backlog: `[{ "id", "title", "status", "notes" }]`
  (items with `"status": "done"` are ignored).
- **`state/context.md`** — rolling "what we were just doing." The agent is asked to
  append a one-line note here each tick, so continuity survives across ticks.

`<!-- HTML comments -->` are stripped, so the placeholder hints never reach the prompt.
**Out of the box (no mission, empty queue) the heartbeat stays idle** until you set a goal.

## Configure

Copy `config.example.json` to `config.json` and edit:

| Key | Meaning |
|-----|---------|
| `intervalSeconds` | Seconds between ticks (default 1800 = 30 min). |
| `topBacklog` | How many backlog items to include in the prompt. |
| `dryRun` | When true, print the prompt instead of sending it. **Leave true until you've seen it.** |
| `quietHours` | `{ "start": 22, "end": 7 }` — no ticks during this window (wraps midnight). |
| `maxTicksPerDay` | Hard daily cap so it can't run away or rack up cost. |
| `trigger` | How to start a gateway turn — see below. |

## Wire the trigger to your gateway (the one install-specific step)

OpenClaw has **no CLI command** to submit a prompt — its gateway accepts external work through
an authenticated **HTTP webhook ingress** (the gateway `hooks` block). That's a plain POST, which
the `http` trigger adapter already speaks, so wiring is two small config blocks and no code.

**1. Gateway side** — enable the webhook ingress in your OpenClaw gateway config and add a mapping
that routes to an agent run (confirm exact field names against your version):

```json5
{
  hooks: {
    enabled: true,
    // Set hooks.token from your secret manager.
    path: "/hooks",
    mappings: [
      { match: { path: "heartbeat" }, action: "agent", agentId: "main", deliver: true }
    ]
  }
}
```

This exposes `http://<gateway-host>:<gateway.port>/hooks/heartbeat` (default port **18789**),
authenticated with `Authorization: Bearer <token>`.

**2. Heartbeat side** — point the `http` trigger at it (this is the default in `config.example.json`):

```json
"trigger": {
  "type": "http",
  "url": "http://127.0.0.1:18789/hooks/heartbeat",
  "headers": { "Authorization": "Bearer a-long-random-shared-secret" },
  "body": { "prompt": "{{prompt}}" }
}
```

Set the bearer token to your gateway's `hooks.token`. **Verify on your version:** the gateway
`gateway.port`, and **how the POST body maps to the agent's message** — the docs don't fully pin
down whether the prompt should be a `prompt`/`text`/`message` field or the raw body, so adjust the
`body` template (and `{{prompt}}` placement) to match. Target a stable mapping/agent so context
carries across ticks.

> **Alternative — `command` adapter.** If your host *does* expose a CLI that submits a prompt, use
> `{ "type": "command", "command": ["your-cli", "..."], "promptVia": "stdin" }` instead. The stock
> `openclaw` binary does not, so the webhook above is the OpenClaw-native path.

### Live smoke test (one POST to your real gateway)

Once the trigger is wired, confirm the heartbeat → gateway webhook path end to end with a single,
harmless POST (it asks the agent to reply `OK` and do nothing else):

```bash
node heartbeat/scripts/live-smoke.mjs
```

A `2xx` means your gateway accepts the heartbeat's trigger. `401/403` → token mismatch; `404` → the
hooks path/mapping name doesn't match. This covers the *continuation* layer; pair it with
`scripts/verify-openclaw-install.sh` (which confirms the *plugin* loads and its hooks register) for a
full live end-to-end check. Neither runs in CI — both need a real OpenClaw gateway.

## Run

```bash
# 1. See exactly what it would send, using your current state files — sends nothing:
node heartbeat/nrt-heartbeat.mjs --once --dry-run

# 2. Stub the trigger (point command at `cat` or a script) to watch ticks fire safely.

# 3. Once the trigger is wired and dryRun:false, run the loop:
node heartbeat/nrt-heartbeat.mjs           # loops on intervalSeconds
node heartbeat/nrt-heartbeat.mjs --once    # single tick (for a timer/cron)
```

For always-on, install one of the templates in `install/` (systemd service **or** timer,
or a launchd plist) — edit the paths first.

## Safety

- **Dry-run by default**, hard **daily cap**, **quiet hours**, and **idle when no goal** —
  so an always-running agent can't surprise you or burn budget overnight.
- Risky/destructive actions are still gated by the **plugin's approval prompt** on every
  turn, and the finalize reflection still runs — this heartbeat only supplies the *drive*,
  not a bypass of the guardrails.

## Tests

```bash
node --test heartbeat/
```
Covers prompt composition from the three layers, comment stripping, quiet-hours/budget/idle
gating, and the trigger adapters' request building.

## Not in v1

An `agent_end`-driven tick (the plugin signals "tick now" when a turn ends, instead of a
fixed interval). Interval/timer is simpler and OS-supervised; the event-driven variant can
come later.
