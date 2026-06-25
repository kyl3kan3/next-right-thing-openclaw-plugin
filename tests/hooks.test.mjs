import { test } from "node:test";
import assert from "node:assert/strict";

import {
  inferEffectsFromToolCall,
  buildToolCandidate,
  beforeToolCallDecision,
  createNextRightThingPlugin,
} from "../next-right-thing-hooks.mjs";

const exec = (cmd) => ({ toolName: "exec", params: { cmd } });

test("destructive commands infer delete_data (regex word-boundary regression)", () => {
  // These four slipped through before: \b before a dash-prefixed flag never matches.
  const destructive = [
    "rm -rf build",
    "git reset --hard origin/main",
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
  for (const cmd of ["rm -rf x", "rm -fr x", "rm -r -f x", "rm --recursive --force x"]) {
    assert.ok(inferEffectsFromToolCall(exec(cmd)).includes("delete_data"), `expected delete_data for: ${cmd}`);
  }
  // Non-recursive or non-force rm should not trip the destructive gate.
  assert.ok(!inferEffectsFromToolCall(exec("rm -f x")).includes("delete_data"));
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
      headers: { Authorization: "Bearer sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX" },
    },
  };
  assert.ok(inferEffectsFromToolCall(event).includes("security_exposure"));
});

test("command patterns are scanned under non-exec shell tool names", () => {
  const effects = inferEffectsFromToolCall({ toolName: "bash", params: { command: "rm -rf /tmp/x" } });
  assert.ok(effects.includes("delete_data"));
});

test("structured argv arrays are flattened and scanned", () => {
  const argvCalls = [
    { toolName: "exec", params: { cmd: "rm", args: ["-rf", "/tmp/x"] }, effect: "delete_data" },
    { toolName: "exec", params: { cmd: "git", args: ["reset", "--hard"] }, effect: "delete_data" },
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
    { toolName: "exec_command", params: { input: { command: "rm -rf /tmp/x" } }, effect: "delete_data" },
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
    const effects = inferEffectsFromToolCall({ toolName, params: { command: "rm -rf /tmp/x" } });
    assert.ok(effects.includes("delete_data"), `expected delete_data for tool: ${toolName}`);
  }
});

test('destructive/production candidates reach "critical" severity', () => {
  const decision = beforeToolCallDecision(exec("rm -rf /"));
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
