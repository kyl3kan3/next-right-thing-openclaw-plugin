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
    config: { approvalTimeoutMs: 12_345 },
    on(name, handler) {
      registered.push({ name, handler });
    },
  });
  const before = registered.find((r) => r.name === "before_tool_call");
  const decision = await before.handler(exec("vercel deploy --prod"));
  assert.equal(decision.requireApproval.timeoutMs, 12_345);
});
