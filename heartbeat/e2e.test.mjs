// End-to-end test: drive the WHOLE chain the way OpenClaw does, in one process.
//
// Unlike the unit tests (which call the plugin's bare decision functions) and the
// scratchpad integration sim, this exercises the plugin's REGISTERED hook lifecycle:
// build it via createNextRightThingPlugin → collect the api.on(...) registrations →
// invoke those registered handlers with OpenClaw-shaped events. The heartbeat half is
// real too: compose a prompt from seeded state and dispatch it over an actual loopback
// HTTP POST to a stub that mimics OpenClaw's gateway hooks ingress.
//
// Honest boundary: a real OpenClaw gateway + live model turn are NOT reachable here.
// scripts/verify-openclaw-install.sh (plugin load/hooks) and heartbeat/scripts/
// live-smoke.mjs (heartbeat→gateway webhook) cover that on a real machine.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { composePrompt } from "./nrt-heartbeat.mjs";
import { dispatch } from "./trigger/http.mjs";
import { createNextRightThingPlugin } from "../next-right-thing-hooks.mjs";

const REFLECTION_KEY = "next-right-thing-reflection";
const AUDIT_KEY = "next-right-thing-completion-audit";

// The three permissioned layers are opt-in (default off); tests that exercise them
// enable them explicitly, the way an operator would in plugin config.
const ALL_LAYERS_ON = {
  runContext: { enabled: true },
  runtimeCoverage: { enforce: true },
  reflection: { enabled: true },
};

// Build the registered hook handlers as OpenClaw would, by running register()
// against a stub `api` that records every api.on(name, handler, opts).
function registerPlugin(options = {}) {
  const registered = [];
  const plugin = createNextRightThingPlugin((entry) => entry, options);
  plugin.register({
    pluginConfig: options._pluginConfig ?? {},
    on(name, handler, opts) {
      registered.push({ name, handler, opts });
    },
  });
  const find = (name) => registered.find((r) => r.name === name);
  return {
    names: registered.map((r) => r.name),
    promptHook: find("before_prompt_build")?.handler,
    runHook: find("before_agent_run")?.handler,
    toolHook: find("before_tool_call")?.handler,
    finalizeHook: find("before_agent_finalize")?.handler,
  };
}

// A one-shot stub gateway: captures the first POST and returns a started-run reply.
function startStubGateway(token) {
  const captured = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.url = req.url;
      captured.method = req.method;
      captured.auth = req.headers["authorization"];
      captured.contentType = req.headers["content-type"];
      try {
        captured.body = JSON.parse(body);
      } catch {
        captured.body = body;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ runId: "stub-1", status: "started" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, captured, port, token });
    });
  });
}

const STATE = {
  mission: "Grow the newsletter to 1000 subscribers.",
  queue: [
    { id: "a", title: "Draft issue 5", status: "todo" },
    { id: "b", title: "Old finished thing", status: "done" },
  ],
  context: "Last tick: outlined issue 5.",
};

test("E2E: heartbeat composes a layered prompt and dispatches it over a real HTTP POST to the gateway hooks endpoint", async () => {
  const token = "e2e-secret-token";
  const { server, captured, port } = await startStubGateway(token);
  try {
    const prompt = composePrompt(STATE);
    assert.ok(prompt, "composePrompt produced a prompt from a real mission + backlog");

    await dispatch(prompt, {
      url: `http://127.0.0.1:${port}/hooks/heartbeat`,
      headers: { Authorization: `Bearer ${token}` },
      body: { prompt: "{{prompt}}" },
    });

    // The gateway-shaped request arrived intact.
    assert.equal(captured.method, "POST");
    assert.equal(captured.url, "/hooks/heartbeat");
    assert.equal(captured.auth, `Bearer ${token}`);
    assert.match(captured.contentType || "", /json/);

    // The body carries the composed, layered next-right-thing prompt.
    const p = captured.body?.prompt;
    assert.equal(typeof p, "string");
    assert.match(p, /Grow the newsletter to 1000 subscribers/); // mission layer
    assert.match(p, /Draft issue 5/); // open backlog
    assert.doesNotMatch(p, /Old finished thing/); // done item excluded
    assert.match(p, /outlined issue 5/); // context layer
    assert.match(p, /next right thing/i); // directive
  } finally {
    server.close();
  }
});

test("E2E: the registered before_tool_call hook gates a risky action and allows a benign one", async () => {
  const { names, toolHook } = registerPlugin();
  assert.ok(names.includes("before_tool_call"), "approval gate is registered");
  assert.ok(toolHook, "before_tool_call handler is callable");

  const risky = await toolHook({ toolName: "exec", params: { cmd: "rm -rf build && vercel deploy --prod" } });
  assert.equal(risky?.requireApproval?.severity, "critical", "risky prod deploy → critical approval");

  const benign = await toolHook({ toolName: "read_file", params: { path: "README.md" } });
  assert.equal(benign, undefined, "a harmless read passes the gate silently");
});

test("E2E: the registered before_prompt_build hook injects model-agnostic NRT context", async () => {
  const { names, promptHook } = registerPlugin({ runContext: { enabled: true } });
  assert.ok(names.includes("before_prompt_build"), "run context hook is registered");
  assert.ok(promptHook, "before_prompt_build handler is callable");

  const decision = await promptHook({ prompt: "do it", messages: [] }, {});
  assert.match(decision?.prependSystemContext ?? "", /Next Right Thing protocol is active/);
  assert.match(decision?.prependSystemContext ?? "", /OpenClaw-covered tools/);
});

test("E2E: the enforced before_agent_run hook is model-agnostic by default", async () => {
  const { names, runHook } = registerPlugin({ runtimeCoverage: { enforce: true } });
  assert.ok(names.includes("before_agent_run"), "runtime coverage gate is registered");
  assert.ok(runHook, "before_agent_run handler is callable");

  const covered = await runHook(
    { prompt: "do it", messages: [] },
    { modelProviderId: "openai", modelId: "gpt-5.5" },
  );
  assert.deepEqual(covered, { outcome: "pass" }, "OpenClaw embedded/provider-identified runs pass");

  const claude = await runHook(
    { prompt: "do it", messages: [] },
    { agentRuntimeId: "claude-cli", modelProviderId: "anthropic", modelId: "claude-sonnet-4-6" },
  );
  assert.deepEqual(claude, { outcome: "pass" }, "non-OpenAI models can still run under the NRT layer");

  const unidentified = await runHook({ prompt: "do it", messages: [] }, {});
  assert.deepEqual(unidentified, { outcome: "pass" }, "unidentified runtimes pass when the hook itself is invoked");
});

test("E2E: strict runtime coverage policy can still block uncovered runtime ids", async () => {
  const { runHook } = registerPlugin({ runtimeCoverage: { enforce: true, blockedRuntimeIds: ["claude-cli"] } });
  const blocked = await runHook(
    { prompt: "do it", messages: [] },
    { agentRuntimeId: "claude-cli", modelProviderId: "anthropic", modelId: "claude-sonnet-4-6" },
  );
  assert.equal(blocked?.outcome, "block");
  assert.equal(blocked?.category, "runtime_coverage");
});

test("E2E: the registered before_agent_finalize hook forces a one-shot reflection that cannot loop", async () => {
  const { finalizeHook } = registerPlugin({ reflection: { enabled: true } });
  assert.ok(finalizeHook, "finalize gate is registered when reflection is enabled");

  const first = await finalizeHook({});
  assert.equal(first?.action, "revise");
  assert.match(first.retry.instruction, /next right thing/i);
  assert.equal(first.retry.idempotencyKey, REFLECTION_KEY);
  assert.equal(first.retry.maxAttempts, 1, "one-shot: the host runs it once then proceeds");

  // Invoking again yields the SAME stable idempotency key, so OpenClaw dedupes it
  // rather than revising forever.
  const second = await finalizeHook({});
  assert.equal(second.retry.idempotencyKey, first.retry.idempotencyKey);
});

test("E2E: per-call pluginConfig flows through the registered surface (timeout threads in, reflection can disable)", async () => {
  const { toolHook, finalizeHook } = registerPlugin({ reflection: { enabled: true } });

  // approvalTimeoutMs supplied per-call is honored on the produced approval.
  const gated = await toolHook({
    toolName: "exec",
    params: { cmd: "vercel deploy --prod" },
    context: { pluginConfig: { approvalTimeoutMs: 1234 } },
  });
  assert.equal(gated?.requireApproval?.timeoutMs, 1234, "per-call approvalTimeoutMs wins");

  // A per-call reflection disable turns the registered finalize hook into a no-op
  // for that turn (the hook stays registered; it just declines to revise).
  const quiet = await finalizeHook({ context: { pluginConfig: { reflection: { enabled: false } } } });
  assert.equal(quiet, undefined, "per-call reflection.enabled:false suppresses the revise");
});

test("E2E: by default only the approval gate registers; permissioned layers stay opt-in", () => {
  // The default install claims NO permissioned hooks — just the always-on
  // before_tool_call gate. The run context, runtime coverage, and finalize
  // reflection are opt-in, so a default plugin never asks for allowPromptInjection
  // or allowConversationAccess for a no-op.
  const { names } = registerPlugin();
  assert.ok(names.includes("before_tool_call"), "the approval gate always loads");
  assert.ok(!names.includes("before_prompt_build"), "run context is opt-in (off by default)");
  assert.ok(!names.includes("before_agent_run"), "runtime coverage is opt-in (off by default)");
  assert.ok(!names.includes("before_agent_finalize"), "finalize reflection is opt-in (off by default)");

  // Enabling them explicitly registers each permissioned hook.
  const { names: onNames } = registerPlugin(ALL_LAYERS_ON);
  for (const hook of ["before_prompt_build", "before_agent_run", "before_tool_call", "before_agent_finalize"]) {
    assert.ok(onNames.includes(hook), `${hook} registers when its layer is enabled`);
  }
});

test("E2E: a wired completion audit composes AHEAD of reflection, and they never double-revise", async () => {
  // Audit says incomplete → audit revise wins, with the audit idempotency key.
  const incomplete = registerPlugin({
    loadCompletionAudit: async () => ({
      status: "incomplete",
      requirements: [{ requirement: "production proof", status: "missing" }],
    }),
  });
  const audited = await incomplete.finalizeHook({});
  assert.equal(audited?.action, "revise");
  assert.equal(audited.retry.idempotencyKey, AUDIT_KEY, "audit revise outranks reflection");
  assert.match(audited.retry.instruction, /production proof/);

  // Audit says complete → audit yields nothing, so built-in reflection runs instead
  // (reflection enabled here; it composes behind the audit).
  const complete = registerPlugin({
    loadCompletionAudit: async () => ({ status: "complete", requirements: [] }),
    reflection: { enabled: true },
  });
  const reflected = await complete.finalizeHook({});
  assert.equal(reflected?.action, "revise");
  assert.equal(reflected.retry.idempotencyKey, REFLECTION_KEY, "falls through to reflection when proven-complete");
});
