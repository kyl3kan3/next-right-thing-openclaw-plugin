# Scope Review — Next Right Thing OpenClaw Plugin

A review of the current repository (`v0.3.4` + Unreleased) against the **original
scope** established by the published scaffold (`19e52d3`, "Publish OpenClaw
plugin scaffold", v0.2.x).

## 1. What the original scope was

The scaffold defined a deliberately narrow thing: a **dependency-free OpenClaw
*hook* plugin** that wraps prepared turns with policy. From the original
`openclaw-adapter.md` and `README.md`:

- **Core:** `before_tool_call` — infer side effects and request bounded approval
  for production mutation, destructive ops, publishing, messaging, auth/billing
  changes, and secret exposure.
- **Optional:** `before_agent_finalize` — load an *external* completion audit
  (`runtime/nrt_supervisor.py`) and emit a `revise` only when completion was not
  proven.
- **Observation-only (not implemented on purpose):** `after_tool_call`,
  `agent_end`.
- **Bounded approval contract:** ≤256-char description, `allow-once`/`deny`,
  deny-on-timeout, no secrets in approval text.
- **Stated non-goal — "Why This Is Not a Harness":** the plugin is *host policy*
  (goal state, approvals, verification, memory proposals) that should **wrap**
  prepared turns and **not own provider/model selection** or drive the agent.

## 2. Verdict at a glance

| Area | Original scope | Today | Assessment |
|------|----------------|-------|------------|
| `before_tool_call` approval gate | core | present, heavily hardened | ✅ **Faithful** — in-scope hardening |
| Bounded approval prompt contract | required | honored (`MAX_APPROVAL_DESCRIPTION_LENGTH`, redaction, deny-on-timeout) | ✅ **Faithful** |
| `before_agent_finalize` external audit | optional | preserved via `loadCompletionAudit` | ✅ **Faithful** |
| Dependency-free, unit-testable without OpenClaw | required | still true | ✅ **Faithful** |
| `after_tool_call` / `agent_end` | observation-only | not implemented | ✅ As intended |
| Python sidecar (`nrt reviews/scheduler/supervisor`) | described as adjacent | de-scoped out of this repo | ➖ **Narrowed** |
| `before_prompt_build` run-context injection | — | new, default-on | ⚠️ **Expansion** |
| `before_agent_run` runtime-coverage gate | — | new, default-on (model-agnostic) | ⚠️ **Expansion** |
| Built-in reflective deliberation on finalize | — | new, **default-on** | ⚠️ **Behavioral/cost change** |
| `heartbeat/` continuation engine | — | new sub-product | 🚩 **Largest departure** |

The core guardrail is intact and materially stronger. The concerns are all about
**added surface area** and a **directional drift** from "wrap prepared turns"
toward "shape and drive turns."

## 3. Faithful to scope (and improved)

- **`before_tool_call` is the heart of the original scope and it has only gotten
  better.** Effect inference now covers destructive shell primitives beyond
  `rm -rf` (`dd of=`, `mkfs`, `shred/wipefs/blkdiscard`, `find -delete`,
  `truncate`, redirect-truncation, raw block-device writes), destructive SQL
  beyond `DROP/DELETE/TRUNCATE` (mass `UPDATE`, `GRANT/REVOKE`, role/user DDL),
  capitalized MCP tool names, camelCase exec names, and structured/argv payloads
  (`next-right-thing-hooks.mjs:133-209`, `:490-575`). This is exactly the kind of
  hardening the original scope invited.
- **The bounded-approval contract is still honored** verbatim: description capped
  and secret-redacted, `["allow-once","deny"]`, `timeoutBehavior: "deny"`
  (`:666-684`).
- **The original optional audit path survives** unchanged in intent via
  `loadCompletionAudit` → `finalizeDecisionFromAudit` (`:715-733`), and composes
  *ahead of* the new reflection with distinct idempotency keys (`:906-922`).
- **Dependency-free + host-independent testing** still holds: hook logic is pure,
  exercised by `tests/hooks.test.mjs` against a fixture runtime.

## 4. Expansions worth an explicit decision

These are not bugs and are honestly documented — but each enlarges the plugin
beyond the scaffold's "gate and observe" remit and deserves a conscious
keep/trim call.

### 4a. `before_prompt_build` run-context injection — *new posture*
The plugin now injects an NRT operating instruction into **every** model prompt
(`beforePromptBuildDecision`, `:443-457`). The original framing was explicitly
"wrap prepared turns rather than own ... selection." Injecting system context is
a move from *gating* a turn to *shaping its content*. It is defensible (it
delivers the protocol to runtimes that have no finalize hook), but it:
- requires a new trust grant, `allowPromptInjection`, that the core gate never
  needed; and
- means the default install now *writes into* prompts, not just *vetoes* tools.

**Decision to make:** is prompt shaping in-scope for a guardrail plugin, or
should it ship **off by default** (opt-in), keeping the default install a pure
gate?

### 4b. Built-in reflective deliberation — *default-on cost change*
`reflection.enabled` defaults to `true` (`:748-776`, schema default `true`). The
original `before_agent_finalize` was *optional* and *evidence-driven*. The new
behavior guarantees **one extra model pass on every finalize** for every user,
even with no external audit wired. It is well-guarded (one-shot via stable
idempotency key + `maxAttempts: 1`, so it cannot loop) and toggleable — but
**default-on** turns a previously passive hook into an always-present extra
inference with real latency/token cost.

**Decision to make:** keep default-on (accept the per-finalize cost as the
product's opinion), or flip to opt-in so the baseline matches the scaffold's
passive audit posture.

### 4c. `before_agent_run` runtime-coverage gate — *low-yield default hook*
Registered by default (`:877-886`) but in the default config it is
**model-agnostic and almost always passes** (`beforeAgentRunDecision`,
`:398-432`; `allowUnidentifiedRuntime` default `true`, empty block lists). The
git history shows this was first fail-closed on `claude-cli`/`anthropic-cli`,
then walked back to model-agnostic ("Fail closed on uncovered runtimes" →
"Make NRT context model-agnostic") — a sign the boundary here was contested. Net
today: it claims an `allowConversationAccess` hook to do, by default, nearly
nothing. Value is real only when an operator populates `blockedRuntimeIds` /
`blockedProviderIds` or sets `allowUnidentifiedRuntime: false`.

**Decision to make:** is a default-registered no-op gate worth the permission it
consumes, or should `runtimeCoverage.enforce` default to `false` (register only
when an operator actually configures blocking)?

### 4d. `heartbeat/` continuation engine — *the largest departure*
This is a second product in the repo. The plugin's whole premise is "act only
when prompted"; the heartbeat **initiates** turns on a timer (systemd/launchd
units, an HTTP webhook trigger needing a shared secret, a layered
mission/queue/context goal model). That is the *opposite* posture from "wrap
prepared turns" and is explicitly outside "approval gates + completion audit."

To its credit it is cleanly quarantined: separate `heartbeat/` tree, "client of
the gateway, separate from the plugin's hook runtime," **dry-run + idle by
default**, daily cap, and quiet hours. It does not weaken any guardrail — risky
turns it triggers still hit the same `before_tool_call` gate.

**Decision to make:** it is reasonable to ship, but it is arguably its own
package/repo (`@next-right-thing/heartbeat`). Keeping it here means the repo's
identity is now "guardrail plugin **+** autonomous driver," which is a broader
charter than the scaffold's. At minimum, name this expansion deliberately rather
than letting it read as part of the plugin.

## 5. Directional drift (the through-line)

No single addition violates "Why This Is Not a Harness" — none select a
model/provider. But taken together, the project has drifted from a **pure
policy wrapper** toward an **operating layer that also shapes prompts
(`before_prompt_build`) and drives turns (`heartbeat/`)**. The trust surface has
grown accordingly: the scaffold's core value (`before_tool_call`) needed **no
special permission**, whereas the default feature set now needs both
`allowPromptInjection` and `allowConversationAccess`. That is the single most
important scope fact to surface to operators, and the README does call it out.

## 6. Narrowing (the opposite drift)

In one dimension scope *shrank*: the original adapter doc wired this plugin to a
Python runtime sidecar (`nrt reviews run`, `nrt scheduler run-due`,
`nrt supervisor audit-log`, `nrt benchmark`). The current README explicitly
declares that source tree "out of scope for this adapter repository." So the
originally-described deterministic CI/review + scheduler integration is no longer
part of this repo. Fine as a decision — just note it is a real reduction from the
original scope, not only additions.

## 7. Minor / packaging notes

- `index.js` and `index.ts` are byte-identical; only `index.js` is referenced by
  `package.json#openclaw.extensions`. The `.ts` copy is documentation/parity
  only — consider dropping one to avoid drift between them.
- `package.json` is `"private": true` while the README documents
  `openclaw plugins install git:...` (install-from-git, not from npm), so the
  private flag is harmless here but inconsistent with a "publishable plugin"
  reading.

## 8. Recommendation

- **Keep** all of the `before_tool_call` hardening and the bounded-approval
  contract — they are the original scope, executed well.
- **Reconsider the defaults** for the three default-on expansions (run-context
  injection, finalize reflection, runtime-coverage gate). The cleanest alignment
  with the original scope is: core gate on by default with **no extra
  permissions required**, and prompt-injection / reflection / coverage **opt-in**.
  If they stay default-on, treat that as a deliberate product opinion and say so
  in the README's scope statement.
- **Decide the home of `heartbeat/`** — extract to its own package, or keep it
  but formally restate the repo's charter as "guardrail plugin + optional
  continuation engine."
- **Record the Python-sidecar de-scope** as an intentional narrowing.

Bottom line: the **guardrail core is faithful to and stronger than** the original
scope; the **risk is accumulated surface area and a quiet drift** from "wrap
prepared turns" toward "shape and drive them," concentrated in three default-on
hooks and the heartbeat sub-product.
