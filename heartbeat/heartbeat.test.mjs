import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composePrompt,
  openItems,
  shouldRunNow,
  inQuietHours,
  nextTickDelay,
  rolloverIfNewDay,
} from "./nrt-heartbeat.mjs";
import { buildCommand } from "./trigger/command.mjs";
import { buildRequest, injectPrompt } from "./trigger/http.mjs";

const at = (hour) => new Date(2026, 0, 1, hour, 0, 0); // local-time Date at a given hour

test("composePrompt merges all three goal layers", () => {
  const p = composePrompt({
    mission: "Grow the newsletter",
    queue: [{ id: "a", title: "Draft issue 5", status: "todo" }],
    context: "Last tick: outlined issue 5",
  });
  assert.match(p, /Mission/);
  assert.match(p, /Grow the newsletter/);
  assert.match(p, /Open backlog/);
  assert.match(p, /Draft issue 5/);
  assert.match(p, /Recently working on/);
  assert.match(p, /next right thing/i);
});

test("composePrompt drops empty layers", () => {
  const p = composePrompt({ mission: "Ship v1", queue: [], context: "" });
  assert.match(p, /Mission/);
  assert.doesNotMatch(p, /Open backlog/);
  assert.doesNotMatch(p, /Recently working on/);
});

test("composePrompt returns null when there is nothing to pursue", () => {
  assert.equal(composePrompt({ mission: "", queue: [], context: "" }), null);
  assert.equal(composePrompt({ mission: "  ", queue: [{ title: "done one", status: "done" }] }), null);
});

test("comment-only mission/context is treated as empty (idle, no leak)", () => {
  const state = { mission: "<!-- edit me -->", queue: [], context: "<!-- notes -->" };
  assert.equal(composePrompt(state), null);
  assert.equal(shouldRunNow({}, state, at(12), 0).run, false);
  // a comment hint alongside real text is stripped but the text survives
  const p = composePrompt({ mission: "<!-- hint -->Ship v1", queue: [] });
  assert.match(p, /Ship v1/);
  assert.doesNotMatch(p, /hint/);
});

test("openItems excludes done items", () => {
  const items = openItems([
    { id: 1, title: "a", status: "todo" },
    { id: 2, title: "b", status: "done" },
    null,
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 1);
});

test("composePrompt honors topBacklog", () => {
  const queue = Array.from({ length: 10 }, (_, i) => ({ id: i, title: `t${i}`, status: "todo" }));
  const p = composePrompt({ queue }, { topBacklog: 3 });
  assert.match(p, /top 3 of 10/);
  assert.match(p, /t0/);
  assert.doesNotMatch(p, /t5/);
});

test("inQuietHours handles same-day and midnight-wrap windows", () => {
  assert.equal(inQuietHours({ start: 9, end: 17 }, at(12)), true);
  assert.equal(inQuietHours({ start: 9, end: 17 }, at(8)), false);
  // wrap past midnight: quiet 22:00–07:00
  assert.equal(inQuietHours({ start: 22, end: 7 }, at(23)), true);
  assert.equal(inQuietHours({ start: 22, end: 7 }, at(3)), true);
  assert.equal(inQuietHours({ start: 22, end: 7 }, at(9)), false);
  assert.equal(inQuietHours({ start: 5, end: 5 }, at(5)), false); // empty window
});

test("shouldRunNow gates on idle, budget, and quiet hours", () => {
  const state = { mission: "Ship", queue: [] };
  const cfg = { maxTicksPerDay: 24, quietHours: { start: 22, end: 7 } };

  assert.equal(shouldRunNow(cfg, state, at(12), 0).run, true);

  // idle
  assert.equal(shouldRunNow(cfg, { mission: "", queue: [] }, at(12), 0).run, false);
  // over budget
  assert.equal(shouldRunNow(cfg, state, at(12), 24).run, false);
  // quiet hours
  assert.equal(shouldRunNow(cfg, state, at(23), 0).run, false);
});

test("nextTickDelay defaults sanely", () => {
  assert.equal(nextTickDelay({ intervalSeconds: 600 }), 600);
  assert.equal(nextTickDelay({}), 1800);
  assert.equal(nextTickDelay({ intervalSeconds: -5 }), 1800);
});

test("rolloverIfNewDay resets the counter on a new date", () => {
  assert.deepEqual(rolloverIfNewDay({ date: "2026-01-01", count: 5 }, "2026-01-02"), {
    date: "2026-01-02",
    count: 0,
  });
  assert.deepEqual(rolloverIfNewDay({ date: "2026-01-01", count: 5 }, "2026-01-01"), {
    date: "2026-01-01",
    count: 5,
  });
});

test("command trigger builds argv with prompt via stdin or arg", () => {
  const t = { command: ["openclaw", "agent", "run"], promptVia: "stdin" };
  assert.deepEqual(buildCommand("hello", t), { argv: ["openclaw", "agent", "run"], stdin: "hello" });
  assert.deepEqual(buildCommand("hello", { ...t, promptVia: "arg" }), {
    argv: ["openclaw", "agent", "run", "hello"],
    stdin: null,
  });
  assert.throws(() => buildCommand("x", { command: [] }), /non-empty/);
});

test("http trigger injects the prompt into the body template", () => {
  const req = buildRequest("do the thing", {
    url: "http://localhost:9999/run",
    body: { session: "main", message: "{{prompt}}" },
  });
  assert.equal(req.url, "http://localhost:9999/run");
  assert.equal(req.init.method, "POST");
  assert.deepEqual(JSON.parse(req.init.body), { session: "main", message: "do the thing" });
  assert.throws(() => buildRequest("x", {}), /requires a `url`/);
});

test("injectPrompt replaces the sentinel deeply", () => {
  assert.deepEqual(injectPrompt({ a: ["{{prompt}}", { b: "{{prompt}}!" }] }, "X"), {
    a: ["X", { b: "X!" }],
  });
});

test("B6: a string maxTicksPerDay still enforces the budget cap", () => {
  const state = { mission: "go", queue: [] };
  // "24" must coerce to 24 — a config typo must not silently disable the cap.
  assert.equal(shouldRunNow({ maxTicksPerDay: "24" }, state, at(12), 9999).run, false);
  assert.equal(shouldRunNow({ maxTicksPerDay: "24" }, state, at(12), 5).run, true);
});
