# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed (effect-inference completeness — found by the E2E adversarial workflow)

Two gate bypasses surfaced by the end-to-end adversarial test, both reproduced through the
**registered** `before_tool_call` handler and fixed with regression tests (B7/B8):

- **Destructive SQL beyond `DROP`/`DELETE`/`TRUNCATE` was silently allowed** on recognized database
  tools. Mass `UPDATE … SET` (→ `overwrite_data`), `ALTER TABLE … DROP` (→ `overwrite_data`),
  `GRANT`/`REVOKE` (→ `change_permissions`), and `CREATE`/`DROP`/`ALTER ROLE|USER` (→ `change_auth`)
  now infer their proper HARD_EFFECT and require **critical** approval — closing privilege-escalation
  (`GRANT … TO anon`), auth-tampering (`DROP ROLE`), and mass-mutation paths, including aliased
  `UPDATE users u SET …` / `UPDATE users AS u SET …`.
- **Irreversible shell primitives other than `rm -rf` were silently allowed.** `dd … of=`, `mkfs`,
  `shred`/`wipefs`/`blkdiscard`, `find … -delete`, `truncate -s`/`-s0`/`--size=`, data-file truncation
  via redirect (`> app.sqlite`), redirect to a raw block device (`> /dev/sda`, no `of=`), and
  **recursive `rm` without `-f`** now infer `delete_data` and gate as critical. Benign look-alikes
  (`rm file`, `rm -f tmp`, `echo > out.txt`, `> /dev/null`, `dd --help`) still pass.

### Added

- **Fail-closed runtime coverage gate.** The default plugin entry now registers
  `before_agent_run` and blocks known uncovered runtime paths such as
  `claude-cli`/`anthropic-cli`, plus unidentified runtime paths, before
  inference. `runtimeCoverage` config can tune or explicitly disable the layer
  when another runtime relay provides equivalent coverage.
- **Runtime smoke guidance.** Documentation and the verifier now warn that
  `openclaw agent --json` results with `meta.fallbackFrom: "gateway"` are not
  valid hook-coverage evidence; restart the Gateway or force `--local` before
  trusting the smoke.
- **Native hook relay verification.** The install verifier now requires
  gateway-hosted exec routing (`tools.exec.host="gateway"`), `strictInlineEval`,
  and the `openclaw hooks relay` command by default, so Codex app-server native
  shell calls can reach OpenClaw's `before_tool_call` policy instead of running
  under a local/native bypass.
- **Model-agnostic NRT run context.** The default entry now registers
  `before_prompt_build` to inject the Next Right Thing operating context for any
  model that reaches OpenClaw's hook runner. `before_agent_run` remains the
  preflight, but no longer blocks Claude CLI or unidentified runtimes by default;
  strict runtime/provider blocking is opt-in through `runtimeCoverage`.
- **Single-file delete gating.** The tool-call classifier now treats single-file
  deletion primitives (`rm file`, `rm -f file`, `Remove-Item`, `del`, `erase`,
  `unlink`) as `delete_data`, and accepts Codex/OpenClaw bridge event shapes that
  use `name`/`input` or `arguments` instead of `toolName`/`params`.
- **End-to-end test (`heartbeat/e2e.test.mjs`).** Drives the whole chain the way OpenClaw does, in one
  process: composes a layered prompt from seeded state and dispatches it over a real loopback HTTP POST to
  a stub gateway hooks endpoint, then exercises the plugin's **registered** hook lifecycle
  (`createNextRightThingPlugin` → `api.on(...)` → invoke the registered handlers) — covering the
  approval gate (critical vs allow), the one-shot finalize reflection (stable idempotency key, cannot
  loop), per-call `pluginConfig` precedence (`approvalTimeoutMs`, per-turn reflection disable), the
  conversation-access registration guard (no finalize hook when reflection is off and no audit is wired),
  and audit-vs-reflection composition (audit revise outranks reflection; never a double-revise).
- **Live heartbeat smoke script (`heartbeat/scripts/live-smoke.mjs`, manual).** Sends one harmless POST to
  the gateway hooks endpoint from your real `heartbeat/config.json` to verify the heartbeat → gateway
  webhook path on a machine with a running OpenClaw gateway. Complements `scripts/verify-openclaw-install.sh`
  (which verifies the plugin loads and its hooks register). Not run in CI.

## [0.3.4] - 2026-06-26

### Changed

- Documented the OpenClaw native-runtime boundary: `before_tool_call` gates
  OpenClaw-owned dynamic tools, while Claude CLI/native shell execution is
  governed by OpenClaw's native exec policy.
- Verification script now fails by default when it detects unsafe exec policy
  (`security=full` plus `ask=off`), because that setup can bypass the plugin for
  Claude CLI native shell commands. Set `REQUIRE_SAFE_EXEC_POLICY=0` to inspect
  hook registration only.

## [0.3.3] - 2026-06-25

### Fixed

- Verification script now sets `TMPDIR` inside `~/.openclaw` when unset, avoiding
  OpenClaw git-plugin install failures on hosts where `/tmp` and `~/.openclaw`
  are different filesystems.
- Verification script now fails closed unless runtime inspect reports the plugin
  loaded and the `before_tool_call` hook registered.

## [0.3.2] - 2026-06-25

### Fixed

- Verification script now defaults to the current release tag.

## [0.3.1] - 2026-06-25

### Added

- Host-side verification script for cloud/OpenClaw-PI installs. It installs the
  tagged plugin, enables it, restarts the gateway, inspects runtime state, and
  prints the manual approval-gate smoke prompt.

### Fixed (adversarial-test hardening)

An adversarial test workflow found and reproduced six gate bypasses; all are fixed
with regression tests:

- **Capitalized MCP tool names** (`mcp__Gmail__`, `mcp__Slack__`, `mcp__Stripe__`)
  bypassed the messaging/financial name checks — name inference now matches the
  lowercased tool name.
- **Multiline/whitespace SQL** and **SQL split across argv elements** on database
  tools evaded the destructive-SQL scan — params are now normalized (escaped
  whitespace + punctuation → spaces) and that copy is scanned for SQL too.
- **camelCase exec tool names** (`runCommand`) weren't recognized — the tokenizer
  now splits camelCase boundaries.
- **GitHub fine-grained PATs** (`github_pat_…`) weren't detected — added to the
  secret patterns, alongside new Stripe (`sk_live_`/`sk_test_`) and npm token shapes.
- **Heartbeat:** a string `maxTicksPerDay` (e.g. `"24"`) silently disabled the daily
  budget cap — the value is now coerced with `Number()` like its sibling config fields.

### Added

- **Optional `heartbeat/` companion (Layer 3 "continuation engine").** A small,
  dependency-free runner that periodically prompts the OpenClaw gateway with "what's
  the next right thing right now? do it," composed from a layered goal model
  (`mission.md` + `queue.json` + `context.md`). Pluggable trigger adapters (command/http),
  safety knobs (dry-run default, daily cap, quiet hours, idle-when-no-goal), systemd/launchd
  templates, and a `node --test` suite. It supplies the *drive* for an always-on agent while
  the plugin keeps each triggered turn honest. Not part of the plugin's hook runtime.

## [0.3.0] - 2026-06-25

### Added

- **Built-in reflective deliberation (on by default, no runtime required).** The
  `before_agent_finalize` hook is now registered by default. On the agent's first
  finalize attempt it returns one `revise` that makes the model restate the active
  goal, prove it is actually done, name the next right thing if it is not, and
  self-review through the configured review lenses. This finally wires up the
  previously dormant `review_roles` framework.
- New config: `reflection.enabled` (default `true`), `reflection.reviewRoles`
  (extra lenses, merged with the `critic`/`verifier` defaults), and
  `reflection.maxAttempts` (default `1`). Added to all four `configSchema` copies.

### Changed

- A user-supplied `loadCompletionAudit` now **composes ahead of** the built-in
  reflection: an evidence-based audit `revise` wins, otherwise reflection runs. The
  two paths use distinct idempotency keys (`next-right-thing-completion-audit` vs
  `next-right-thing-reflection`) and never double-revise on the same attempt.

### Notes

- The reflection is a **one-shot** (`maxAttempts: 1` + stable idempotency key), so it
  costs exactly one extra pass and cannot loop. Set `reflection.enabled: false` to
  disable. If the host ignores `revise` on finalize, behavior degrades to the prior
  status quo (finalize proceeds).

## [0.2.2] - 2026-06-25

### Fixed (approval-gate bypasses)

- **Destructive-command regexes never matched.** Patterns used `\b` before a
  dash-prefixed flag, which never matches a space→dash boundary, so
  `git reset --hard`, `git clean -f`, `Remove-Item -Recurse`, and
  `curl -X DELETE` bypassed the gate entirely. Now use `\s` before flags.
- **Destructive SQL via database tools.** `DROP TABLE/DATABASE/SCHEMA`,
  `DELETE FROM`, and `TRUNCATE` were only scanned for exec/shell tools, so
  dedicated database tools (`execute_sql`, `postgres_query`, `d1_database_query`,
  …) that carry SQL in params were never gated. SQL is now scanned for
  database- and exec-like tools.
- **Nested and structured command payloads.** Commands hidden in object-valued
  `input`/`script` params, or split into `args`/`argv` arrays, bypassed the
  destructive scans. The exec path now scans the serialized, punctuation-
  normalized params.
- **Long-form / alternate flags.** `git clean --force`, `curl --request DELETE`,
  `rm -fr` / `rm --recursive --force`, `git push --force` / `git push origin +main`
  are now detected.
- **Secret detection** now scans all params (not just the command string) and
  recognizes Google API keys, GitLab PATs, and JWTs.
- **`"critical"` severity** is now reachable (destructive/production effects), and
  the advertised **`approvalTimeoutMs`** config knob is actually read and honored.
- **`moves_goal`** is normalized so a string `"false"` blocks as expected.

### Changed

- Destructive-SQL detection is scoped to database- and exec-like tools so that
  harmless SQL *text* (e.g. a web search mentioning `DELETE FROM`) no longer
  triggers an approval prompt.

### Added

- Self-contained `node --test` suite (`tests/hooks.test.mjs`) and an `npm test`
  script.
- CI workflow running the tests on Node 20.x and 22.x, with pinned action SHAs.
- `LICENSE` (MIT), `CHANGELOG.md`, and `.gitignore`.

## [0.2.1] - prior release

Initial published OpenClaw hook-plugin scaffold (predates this changelog).
