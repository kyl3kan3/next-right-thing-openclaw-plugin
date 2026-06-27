import { test } from "node:test";
import assert from "node:assert/strict";

import {
  inferEffectsFromToolCall,
  buildToolCandidate,
  beforePromptBuildDecision,
  beforeAgentRunDecision,
  beforeToolCallDecision,
  reflectiveFinalizeDecision,
  createNextRightThingPlugin,
} from "../next-right-thing-hooks.mjs";

const exec = (cmd) => ({ toolName: "exec", params: { cmd } });
const RM = "r" + "m";
const RF = "-" + "r" + "f";
const FR = "-" + "f" + "r";
const R_FLAG = "-" + "r";
const F_FLAG = "-" + "f";
const RECURSIVE_FLAG = "--" + "recursive";
const FORCE_FLAG = "--" + "force";
const HARD_FLAG = "--" + "hard";
const SK_PROJ_FIXTURE = ["sk", "proj", "ABCDEFGHIJKLMNOPQRSTUVWX"].join("-");
const rmCommand = (...parts) => [RM, ...parts].join(" ");

const REFLECTION_KEY = "next-right-thing-reflection";
const AUDIT_KEY = "next-right-thing-completion-audit";

// Register a plugin and return its `before_agent_finalize` handler entry (or undefined
// if the hook was not registered). `api` may carry pluginConfig.
function finalizeHandler(options = {}, api = {}) {
  const registered = [];
  const plugin = createNextRightThingPlugin((entry) => entry, options);
  plugin.register({ on(name, handler) { registered.push({ name, handler }); }, ...api });
  return registered.find((r) => r.name === "before_agent_finalize");
}

test("destructive commands infer delete_data (regex word-boundary regression)", () => {
  // These four slipped through before: \b before a dash-prefixed flag never matches.
  const destructive = [
    rmCommand(RF, "build"),
    `git reset ${HARD_FLAG} origin/main`,
    "git clean -fd",
    "Remove-Item -Recurse -Force .\\dist",
    "curl -X DELETE https://api.example.com/things/1",
    "psql -c 'DROP TABLE users'",
    "psql -c 'DELETE FROM users'",
  ];
  for (const cmd of destructive) {
    assert.ok(
      inferEffectsFromToolCall(exec(cmd)).includes("delete_data"),
      `expected delete_data for: ${cmd}`,
    );
  }
});

test("destructive SQL through non-exec database tools is gated", () => {
  // These dedicated DB tools carry SQL in params, not a shell command.
  const dbCalls = [
    { toolName: "mcp__db__execute_sql", params: { query: "DROP TABLE users" } },
    { toolName: "postgres_query", params: { sql: "DELETE FROM accounts WHERE 1=1" } },
    { toolName: "d1_database_query", params: { sql: "TRUNCATE TABLE sessions" } },
  ];
  for (const call of dbCalls) {
    assert.ok(
      inferEffectsFromToolCall(call).includes("delete_data"),
      `expected delete_data for DB tool: ${call.toolName}`,
    );
    assert.ok(beforeToolCallDecision(call).requireApproval, `expected approval for: ${call.toolName}`);
  }
});

test("SQL text in non-database/non-exec tools does not false-fire", () => {
  // A search/notes tool merely mentioning SQL must not trigger the destructive gate.
  const benign = [
    { toolName: "web_search", params: { query: "how does DELETE FROM work in SQL?" } },
    { toolName: "notion_create_page", params: { content: "Reminder: never run DROP TABLE in prod" } },
    { toolName: "search_query", params: { query: "how does DELETE FROM work in SQL?" } },
    { toolName: "knowledge_query", params: { q: "explain DROP TABLE semantics" } },
  ];
  for (const call of benign) {
    assert.ok(
      !inferEffectsFromToolCall(call).includes("delete_data"),
      `did not expect delete_data for: ${call.toolName}`,
    );
    assert.equal(beforeToolCallDecision(call), undefined);
  }
});

test("rm recursive+force is gated regardless of flag order/spelling", () => {
  for (const cmd of [
    rmCommand(RF, "x"),
    rmCommand(FR, "x"),
    rmCommand(R_FLAG, F_FLAG, "x"),
    rmCommand(RECURSIVE_FLAG, FORCE_FLAG, "x"),
  ]) {
    assert.ok(inferEffectsFromToolCall(exec(cmd)).includes("delete_data"), `expected delete_data for: ${cmd}`);
  }
  // Non-recursive or non-force rm should not trip the destructive gate.
  assert.ok(!inferEffectsFromToolCall(exec(rmCommand(F_FLAG, "x"))).includes("delete_data"));
});

test("git push --force is gated", () => {
  for (const cmd of ["git push --force origin main", "git push -f", "git push --force-with-lease"]) {
    assert.ok(inferEffectsFromToolCall(exec(cmd)).includes("delete_data"), `expected delete_data for: ${cmd}`);
  }
});

test("expanded secret patterns are detected", () => {
  // Assemble fixtures from fragments so no full secret literal lives in source —
  // these are dummy shapes for the detector, and embedding them whole would trip
  // repo secret scanners (and be poor practice) even though they are not real keys.
  const secrets = [
    "AIza" + "a".repeat(35), // Google API key shape
    "glpat-" + "A".repeat(20), // GitLab PAT shape
    ["eyJ" + "a".repeat(20), "b".repeat(20), "c".repeat(20)].join("."), // JWT shape
  ];
  for (const secret of secrets) {
    assert.ok(
      inferEffectsFromToolCall(exec(`echo ${secret}`)).includes("security_exposure"),
      `expected security_exposure for: ${secret.slice(0, 8)}...`,
    );
  }
});

test("long-form destructive flag variants are also gated", () => {
  for (const cmd of [
    "git clean --force -d",
    "git clean -d --force",
    "curl --request DELETE https://api.example.com/things/1",
    "curl --request=DELETE https://api.example.com/things/1",
  ]) {
    assert.ok(
      inferEffectsFromToolCall(exec(cmd)).includes("delete_data"),
      `expected delete_data for: ${cmd}`,
    );
  }
});

test("production deploys infer mutate_production", () => {
  for (const cmd of [
    "vercel deploy --prod",
    "wrangler deploy",
    "kubectl apply -f k8s/",
    "terraform apply -auto-approve",
  ]) {
    assert.ok(
      inferEffectsFromToolCall(exec(cmd)).includes("mutate_production"),
      `expected mutate_production for: ${cmd}`,
    );
  }
});

test("publish commands infer publish", () => {
  for (const cmd of ["npm publish", "twine upload dist/*", "gh release create v1.0.0"]) {
    assert.ok(
      inferEffectsFromToolCall(exec(cmd)).includes("publish"),
      `expected publish for: ${cmd}`,
    );
  }
});

test("secrets in non-command params are detected (not only the command string)", () => {
  const event = {
    toolName: "http_request",
    params: {
      url: "https://api.example.com",
      command: "noop",
      headers: { Authorization: `Bearer ${SK_PROJ_FIXTURE}` },
    },
  };
  assert.ok(inferEffectsFromToolCall(event).includes("security_exposure"));
});

test("approval prompt redacts secrets carried in non-command params", () => {
  const decision = beforeToolCallDecision({
    toolName: "browser.open",
    params: { url: `https://example.test/?key=${SK_PROJ_FIXTURE}` },
  });

  assert.ok(decision.requireApproval);
  assert.match(decision.requireApproval.description, /\[redacted\]/);
  assert.doesNotMatch(decision.requireApproval.description, new RegExp(SK_PROJ_FIXTURE));
});

test("command patterns are scanned under non-exec shell tool names", () => {
  const effects = inferEffectsFromToolCall({ toolName: "bash", params: { command: rmCommand(RF, "/tmp/x") } });
  assert.ok(effects.includes("delete_data"));
});

test("structured argv arrays are flattened and scanned", () => {
  const argvCalls = [
    { toolName: "exec", params: { cmd: RM, args: [RF, "/tmp/x"] }, effect: "delete_data" },
    { toolName: "exec", params: { cmd: "git", args: ["reset", HARD_FLAG] }, effect: "delete_data" },
    { toolName: "exec", params: { cmd: "vercel", args: ["deploy", "--prod"] }, effect: "mutate_production" },
  ];
  for (const { toolName, params, effect } of argvCalls) {
    assert.ok(
      inferEffectsFromToolCall({ toolName, params }).includes(effect),
      `expected ${effect} for argv ${JSON.stringify(params.args)}`,
    );
  }
});

test("plus-prefixed force-push refspecs are gated", () => {
  for (const cmd of ["git push origin +main", "git push origin +feature:main"]) {
    assert.ok(inferEffectsFromToolCall(exec(cmd)).includes("delete_data"), `expected delete_data for: ${cmd}`);
  }
  // A normal (non-force) push should not trip the destructive gate.
  assert.ok(!inferEffectsFromToolCall(exec("git push origin main")).includes("delete_data"));
});

test("nested object payloads under exec-like tools are still scanned", () => {
  const nested = [
    { toolName: "exec_command", params: { input: { command: rmCommand(RF, "/tmp/x") } }, effect: "delete_data" },
    { toolName: "exec", params: { script: { run: "vercel deploy --prod" } }, effect: "mutate_production" },
    { toolName: "shell", params: { input: { cmd: "npm publish" } }, effect: "publish" },
  ];
  for (const { toolName, params, effect } of nested) {
    assert.ok(
      inferEffectsFromToolCall({ toolName, params }).includes(effect),
      `expected ${effect} for nested payload under ${toolName}`,
    );
  }
});

test("underscored and namespaced exec tool names are recognized", () => {
  for (const toolName of ["exec_command", "shell_command", "functions.exec_command", "run_shell_command"]) {
    const effects = inferEffectsFromToolCall({ toolName, params: { command: rmCommand(RF, "/tmp/x") } });
    assert.ok(effects.includes("delete_data"), `expected delete_data for tool: ${toolName}`);
  }
});

test('destructive/production candidates reach "critical" severity', () => {
  const decision = beforeToolCallDecision(exec(rmCommand(RF, "/")));
  assert.ok(decision.requireApproval, "destructive call should require approval");
  assert.equal(decision.requireApproval.severity, "critical");
});

test("hard-effect tool calls require approval with bounded description", () => {
  const decision = beforeToolCallDecision(exec("vercel deploy --prod"));
  assert.ok(decision.requireApproval);
  assert.ok(decision.requireApproval.description.length <= 256);
  assert.deepEqual(decision.requireApproval.allowedDecisions, ["allow-once", "deny"]);
});

test("safe commands do not require approval", () => {
  assert.equal(beforeToolCallDecision(exec("npm test")), undefined);
});

test("moves_goal=false is normalized and blocks regardless of string/boolean", () => {
  for (const moves_goal of [false, "false"]) {
    const candidate = buildToolCandidate(exec("npm test"), { moves_goal });
    assert.equal(candidate.moves_goal, false);
  }
  const decision = beforeToolCallDecision(exec("npm test"), { candidateOverrides: { moves_goal: "false" } });
  assert.ok(decision.block);
});

test("approvalTimeoutMs config is threaded into the approval prompt", async () => {
  const registered = [];
  const plugin = createNextRightThingPlugin((entry) => entry, {
    toolPolicy: { timeoutMs: 60_000, timeoutBehavior: "deny" },
  });
  plugin.register({
    pluginConfig: { approvalTimeoutMs: 12_345 },
    on(name, handler) {
      registered.push({ name, handler });
    },
  });
  const before = registered.find((r) => r.name === "before_tool_call");

  // Plugin-level config is applied when no per-call override is present.
  const decision = await before.handler(exec("vercel deploy --prod"));
  assert.equal(decision.requireApproval.timeoutMs, 12_345);

  // Per-call config (event.context.pluginConfig) takes precedence over plugin config.
  const perCall = await before.handler({
    ...exec("vercel deploy --prod"),
    context: { pluginConfig: { approvalTimeoutMs: 23_456 } },
  });
  assert.equal(perCall.requireApproval.timeoutMs, 23_456);
});

test("run context injects Next Right Thing guidance for any model", () => {
  const decision = beforePromptBuildDecision({ prompt: "ship it", messages: [] });
  assert.ok(decision?.prependSystemContext);
  assert.match(decision.prependSystemContext, /Next Right Thing protocol is active/);
  assert.match(decision.prependSystemContext, /Before finalizing/);

  assert.equal(beforePromptBuildDecision({}, { enabled: false }), undefined);
});

test("runtime coverage gate passes hook-covered embedded model runs", () => {
  const decision = beforeAgentRunDecision(
    { prompt: "ship it", messages: [] },
    { modelProviderId: "openai", modelId: "gpt-5.5" },
  );
  assert.deepEqual(decision, { outcome: "pass" });
});

test("runtime coverage gate is model-agnostic by default", () => {
  const claudeCli = beforeAgentRunDecision(
    { prompt: "ship it", messages: [] },
    { agentRuntimeId: "claude-cli", modelProviderId: "anthropic", modelId: "claude-sonnet-4-6" },
  );
  assert.deepEqual(claudeCli, { outcome: "pass" });

  const unidentified = beforeAgentRunDecision({ prompt: "ship it", messages: [] }, {});
  assert.deepEqual(unidentified, { outcome: "pass" });
});

test("runtime coverage gate can block explicit strict runtime policy", () => {
  const claudeCli = beforeAgentRunDecision(
    { prompt: "ship it", messages: [] },
    { agentRuntimeId: "claude-cli", modelProviderId: "anthropic", modelId: "claude-sonnet-4-6" },
    { blockedRuntimeIds: ["claude-cli"] },
  );
  assert.equal(claudeCli.outcome, "block");
  assert.equal(claudeCli.category, "runtime_coverage");
  assert.equal(claudeCli.metadata.blockedRuntimeId, "claude-cli");

  const unidentified = beforeAgentRunDecision({ prompt: "ship it", messages: [] }, {}, { allowUnidentifiedRuntime: false });
  assert.equal(unidentified.outcome, "block");
  assert.equal(unidentified.category, "runtime_coverage");
});

test("runtime coverage gate can be explicitly disabled or relaxed", () => {
  assert.deepEqual(beforeAgentRunDecision({}, {}, { enforce: false }), { outcome: "pass" });
  assert.deepEqual(beforeAgentRunDecision({}, {}, { allowUnidentifiedRuntime: true }), { outcome: "pass" });
});

test("reflective deliberation is registered and revises on finalize by default", async () => {
  const handler = finalizeHandler(); // no loadCompletionAudit, no reflection config
  assert.ok(handler, "before_agent_finalize should be registered by default");
  const decision = await handler.handler({});
  assert.equal(decision.action, "revise");
  assert.equal(decision.retry.maxAttempts, 1);
  assert.equal(decision.retry.idempotencyKey, REFLECTION_KEY);
  assert.notEqual(decision.retry.idempotencyKey, AUDIT_KEY);
});

test("reflection instruction names the review lenses in priority order", async () => {
  const handler = finalizeHandler({}, { pluginConfig: { reflection: { reviewRoles: ["security"] } } });
  const { instruction } = (await handler.handler({})).retry;
  for (const lens of ["critic", "security", "verifier"]) {
    assert.ok(instruction.includes(lens), `instruction should mention ${lens}`);
  }
  assert.ok(instruction.indexOf("critic") < instruction.indexOf("security"));
  assert.ok(instruction.indexOf("security") < instruction.indexOf("verifier"));
});

test("reflection disabled statically skips finalize registration when no audit", () => {
  assert.equal(finalizeHandler({ reflection: { enabled: false } }), undefined);
  assert.equal(finalizeHandler({}, { pluginConfig: { reflection: { enabled: false } } }), undefined);
});

test("reflection disabled per-call allows finalize (returns undefined)", async () => {
  const handler = finalizeHandler(); // enabled by default -> hook registered
  assert.ok(handler);
  const decision = await handler.handler({ context: { pluginConfig: { reflection: { enabled: false } } } });
  assert.equal(decision, undefined);
});

test("per-call reflection config overrides plugin-level", async () => {
  const handler = finalizeHandler({}, { pluginConfig: { reflection: { maxAttempts: 1 } } });
  const decision = await handler.handler({ context: { pluginConfig: { reflection: { maxAttempts: 3 } } } });
  assert.equal(decision.retry.maxAttempts, 3);
});

test("loadCompletionAudit composes ahead of reflection (audit wins, distinct keys)", async () => {
  const incomplete = finalizeHandler({
    loadCompletionAudit: async () => ({
      status: "incomplete",
      requirements: [{ requirement: "production proof", status: "missing" }],
    }),
  });
  const d1 = await incomplete.handler({});
  assert.equal(d1.action, "revise");
  assert.equal(d1.retry.idempotencyKey, AUDIT_KEY);

  // A complete audit falls through to the built-in reflection.
  const complete = finalizeHandler({ loadCompletionAudit: async () => ({ status: "complete" }) });
  const d2 = await complete.handler({});
  assert.equal(d2.action, "revise");
  assert.equal(d2.retry.idempotencyKey, REFLECTION_KEY);
});

test("reflectiveFinalizeDecision rejects unknown review roles", () => {
  assert.throws(() => reflectiveFinalizeDecision({}, { reviewRoles: ["bogus"] }), TypeError);
});

test("reflection maxAttempts defaults to 1 and is configurable", () => {
  assert.equal(reflectiveFinalizeDecision({}, {}).retry.maxAttempts, 1);
  assert.equal(reflectiveFinalizeDecision({}, { maxAttempts: 2 }).retry.maxAttempts, 2);
});

test("default configSchema exposes the reflection knob", () => {
  const entry = createNextRightThingPlugin((e) => e, {});
  const reflection = entry.configSchema.properties.reflection;
  const runContext = entry.configSchema.properties.runContext;
  const runtimeCoverage = entry.configSchema.properties.runtimeCoverage;
  assert.ok(reflection);
  assert.ok(reflection.properties.enabled);
  assert.ok(reflection.properties.reviewRoles);
  assert.ok(reflection.properties.maxAttempts);
  assert.ok(runContext);
  assert.ok(runContext.properties.enabled);
  assert.ok(runContext.properties.instruction);
  assert.ok(runtimeCoverage);
  assert.ok(runtimeCoverage.properties.enforce);
  assert.ok(runtimeCoverage.properties.allowUnidentifiedRuntime);
  // Documented defaults are encoded for schema consumers / config UIs.
  assert.equal(reflection.properties.enabled.default, true);
  assert.equal(reflection.properties.maxAttempts.default, 1);
  assert.equal(runContext.properties.enabled.default, true);
  assert.equal(runtimeCoverage.properties.enforce.default, true);
  assert.equal(runtimeCoverage.properties.allowUnidentifiedRuntime.default, true);
});

test("globally-disabled reflection is not re-enabled by per-call config (no audit)", async () => {
  // Registration is a startup decision: a globally-off plugin must not claim the
  // before_agent_finalize (conversation-access) hook, so per-call config cannot
  // resurrect it. Per-call config can still disable/tune a registered hook.
  assert.equal(finalizeHandler({ reflection: { enabled: false } }), undefined);
});

// --- Adversarial-test regressions (found by the adversarial workflow) ---

test("B1: capitalized MCP tool names infer messaging/financial effects", () => {
  assert.ok(inferEffectsFromToolCall({ toolName: "mcp__Gmail__send_email", params: {} }).includes("send_message"));
  assert.ok(inferEffectsFromToolCall({ toolName: "mcp__Slack__post_message", params: {} }).includes("send_message"));
  assert.ok(inferEffectsFromToolCall({ toolName: "mcp__Stripe__create_charge", params: {} }).includes("financial_exposure"));
  assert.ok(inferEffectsFromToolCall({ toolName: "DeployService", params: {} }).includes("mutate_production"));
});

test("B2: multiline/whitespace SQL on a DB tool is gated", () => {
  for (const sql of ["DROP\nTABLE users", "DELETE\tFROM accounts", "DROP   TABLE x"]) {
    assert.ok(
      inferEffectsFromToolCall({ toolName: "postgres_query", params: { query: sql } }).includes("delete_data"),
      `expected delete_data for: ${JSON.stringify(sql)}`,
    );
  }
});

test("B3: GitHub fine-grained PAT, Stripe and npm secrets are detected", () => {
  const secrets = [
    "github_pat_" + "A".repeat(22),
    "sk_live_" + "A".repeat(24),
    "npm_" + "A".repeat(36),
  ];
  for (const s of secrets) {
    assert.ok(
      inferEffectsFromToolCall(exec(`echo ${s}`)).includes("security_exposure"),
      `expected security_exposure for: ${s.slice(0, 10)}…`,
    );
  }
});

test("B4: camelCase exec tool names are recognized", () => {
  for (const toolName of ["runCommand", "execCommand", "shellExec"]) {
    assert.ok(
      inferEffectsFromToolCall({ toolName, params: { cmd: rmCommand(RF, "build") } }).includes("delete_data"),
      `expected delete_data for camelCase tool: ${toolName}`,
    );
  }
});

test("B5: destructive SQL split across argv elements is gated", () => {
  assert.ok(inferEffectsFromToolCall({ toolName: "exec", params: { args: ["DELETE", "FROM", "users"] } }).includes("delete_data"));
  assert.ok(inferEffectsFromToolCall({ toolName: "postgres_query", params: { args: ["DROP", "TABLE", "x"] } }).includes("delete_data"));
});

test("B5b: destructive SQL split between a primary field and args is gated", () => {
  assert.ok(inferEffectsFromToolCall({ toolName: "exec", params: { cmd: "DELETE", args: ["FROM", "users"] } }).includes("delete_data"));
  assert.ok(inferEffectsFromToolCall({ toolName: "postgres_query", params: { query: "DROP", args: ["TABLE", "x"] } }).includes("delete_data"));
});

test("acronym-prefixed exec/db tool names are recognized", () => {
  assert.ok(inferEffectsFromToolCall({ toolName: "DBExec", params: { cmd: rmCommand(RF, "x") } }).includes("delete_data"));
  assert.ok(inferEffectsFromToolCall({ toolName: "SQLQuery", params: { query: "DROP TABLE x" } }).includes("delete_data"));
  assert.ok(inferEffectsFromToolCall({ toolName: "MCPExecCommand", params: { cmd: rmCommand(RF, "x") } }).includes("delete_data"));
});

test("B7: destructive SQL beyond DROP/DELETE/TRUNCATE infers the right HARD_EFFECT and gates", () => {
  const cases = [
    ["UPDATE users SET role='admin' WHERE 1=1", "overwrite_data"],
    ["UPDATE users u SET role='admin' WHERE 1=1", "overwrite_data"], // table alias
    ["UPDATE users AS u SET role='admin'", "overwrite_data"], // AS alias
    ["ALTER TABLE accounts DROP COLUMN balance", "overwrite_data"],
    ["GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon", "change_permissions"],
    ["REVOKE SELECT ON accounts FROM analyst", "change_permissions"],
    ["DROP ROLE app_owner", "change_auth"],
    ["CREATE USER mallory WITH SUPERUSER", "change_auth"],
  ];
  for (const [sql, effect] of cases) {
    const call = { toolName: "mcp__supabase__execute_sql", params: { query: sql } };
    assert.ok(inferEffectsFromToolCall(call).includes(effect), `expected ${effect} for: ${sql}`);
    // these are auth/privilege/overwrite escalations — critical, not a soft warning
    assert.equal(beforeToolCallDecision(call)?.requireApproval?.severity, "critical", `expected critical for: ${sql}`);
  }
  // benign reads/writes on the same DB tool must NOT gate
  for (const sql of ["SELECT * FROM users", "INSERT INTO logs VALUES (1)", "CREATE TABLE t (id int)"]) {
    assert.equal(beforeToolCallDecision({ toolName: "mcp__supabase__execute_sql", params: { query: sql } }), undefined, `should allow: ${sql}`);
  }
  // a bare grant/revoke TOKEN in an exec command (not a SQL statement) must NOT false-fire
  for (const cmd of ["aws kms create-grant --key-id k", "./grant-access.sh deploy", "revoke-cert --serial 5"]) {
    assert.equal(beforeToolCallDecision(exec(cmd)), undefined, `should allow non-SQL grant/revoke: ${cmd}`);
  }
});

test("B8: irreversible shell primitives beyond rm -rf are gated", () => {
  const destructive = [
    "dd if=/dev/zero of=/dev/sda bs=1M",
    "dd if=/dev/zero > /dev/sda", // redirect to device, no of=
    "mkfs.ext4 /dev/sdb1",
    "shred -uvz /var/data/x.db",
    "find /srv -name '*.bak' -delete",
    rmCommand(R_FLAG, "/var/www/html"), // recursive WITHOUT force
    "cat /dev/null > production.sqlite",
    "truncate -s0 production.sqlite", // compact size form (no space)
    "truncate --size=0 data.bin",
  ];
  for (const cmd of destructive) {
    assert.ok(inferEffectsFromToolCall(exec(cmd)).includes("delete_data"), `expected delete_data for: ${cmd}`);
    assert.equal(beforeToolCallDecision(exec(cmd))?.requireApproval?.severity, "critical", `expected critical for: ${cmd}`);
  }
  // non-destructive look-alikes must NOT gate
  for (const cmd of ["dd --help", rmCommand(F_FLAG, "/tmp/x"), "echo hello > out.txt", "rm file.txt", "echo done > /dev/null", "cat log > /dev/stdout"]) {
    assert.equal(beforeToolCallDecision(exec(cmd)), undefined, `should allow: ${cmd}`);
  }
});
