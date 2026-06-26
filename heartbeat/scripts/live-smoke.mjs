// Live heartbeat → gateway smoke test (MANUAL — run on a machine with a real
// OpenClaw gateway). NOT run in CI: there is no gateway there.
//
// This closes the one layer the committed tests cannot reach: it sends ONE real
// POST to the gateway hooks endpoint configured in heartbeat/config.json, using
// the same http trigger the heartbeat uses, with a deliberately harmless prompt.
// A 2xx means the heartbeat → gateway webhook path is wired correctly.
//
// It is the continuation-engine counterpart to scripts/verify-openclaw-install.sh
// (which verifies the PLUGIN loads and its hooks register). Together they cover the
// live end-to-end path: this proves the gateway accepts the heartbeat's trigger;
// the install verifier proves the plugin then governs the resulting turn.
//
// Usage:   node heartbeat/scripts/live-smoke.mjs
//          PROMPT="custom prompt" node heartbeat/scripts/live-smoke.mjs
//
// Requires heartbeat/config.json with an `http` trigger (url + auth headers).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildRequest } from "../trigger/http.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, "..", "config.json");

const HARMLESS_PROMPT =
  process.env.PROMPT ??
  "This is a connectivity smoke test. Reply with only the single word OK and take no other action.";

function fail(msg, code = 1) {
  console.error(`\n✗ ${msg}`);
  process.exit(code);
}

let raw;
try {
  raw = await readFile(CONFIG_PATH, "utf8");
} catch {
  fail(
    `No heartbeat/config.json found at ${CONFIG_PATH}.\n` +
      `Copy heartbeat/config.example.json to heartbeat/config.json and set your gateway hooks url + token first.`,
  );
}

let config;
try {
  config = JSON.parse(raw);
} catch (err) {
  fail(`heartbeat/config.json is not valid JSON: ${err.message}`);
}

const trigger = config.trigger ?? {};
if (trigger.type !== "http") {
  fail(
    `This smoke test targets the OpenClaw http webhook trigger, but config.trigger.type is "${trigger.type ?? "unset"}".\n` +
      `Point the trigger at your gateway hooks endpoint (see heartbeat/README.md).`,
  );
}

const { url, init } = buildRequest(HARMLESS_PROMPT, trigger);
const hasAuth = Object.keys(init.headers).some((h) => h.toLowerCase() === "authorization");
if (!hasAuth) {
  console.warn("⚠ no Authorization header configured — most gateway hooks endpoints require a bearer token.");
}

console.log(`→ POST ${url}`);
console.log(`  prompt: ${HARMLESS_PROMPT}`);

let res;
try {
  res = await fetch(url, init);
} catch (err) {
  fail(
    `Could not reach the gateway at ${url}: ${err.message}\n` +
      `Is the OpenClaw gateway running, and is gateway.hooks enabled with a matching mapping?`,
    2,
  );
}

const text = await res.text().catch(() => "");
if (!res.ok) {
  fail(
    `Gateway responded ${res.status} ${res.statusText}.\n` +
      `401/403 → token mismatch (hooks.token vs your Authorization header).\n` +
      `404 → the hooks path/mapping name does not match your gateway config.\n` +
      `Body: ${text.slice(0, 400)}`,
    3,
  );
}

console.log(`\n✓ Gateway accepted the heartbeat trigger (${res.status} ${res.statusText}).`);
if (text) console.log(`  response: ${text.slice(0, 400)}`);
console.log(
  "\nNext: confirm a run actually appeared in your OpenClaw Control UI / gateway logs, and that the\n" +
    "agent replied 'OK'. Then run scripts/verify-openclaw-install.sh to confirm the plugin governs the turn.",
);
