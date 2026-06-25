# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

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
