// Next-Right-Thing Heartbeat — Layer 3 "continuation engine".
//
// OpenClaw is request-driven, so it only acts when prompted. This small,
// dependency-free runner periodically asks the gateway "what's the next right
// thing right now? do it", composing one prompt from three layered goal sources
// (a standing mission, a task backlog, and recent working context). The
// next-right-thing PLUGIN then keeps each resulting turn honest (gates risk,
// forces the finalize reflection). This file is a CLIENT of the gateway, not part
// of the plugin's hook runtime.
//
// Pure functions are exported for tests; side effects live in main().

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_DIR = join(HERE, "state");
const RUNTIME_FILE = ".runtime.json"; // budget bookkeeping, lives in the state dir

// ---------------------------------------------------------------------------
// Pure core (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Compose ONE prompt from the three goal layers. Empty layers drop out. Returns
 * null when there is nothing to pursue (no mission and no open backlog item).
 * @param {{mission?:string, queue?:Array, context?:string}} state
 * @param {{topBacklog?:number}} [options]
 * @returns {string|null}
 */
export function composePrompt(state, options = {}) {
  const topBacklog = Number.isFinite(options.topBacklog) ? options.topBacklog : 5;
  const mission = cleanText(state?.mission);
  const open = openItems(state?.queue);
  const context = cleanText(state?.context);

  if (!mission && open.length === 0) {
    return null;
  }

  const sections = [];
  if (mission) {
    sections.push(`Mission (your north star):\n${mission}`);
  }
  if (open.length) {
    const shown = open.slice(0, Math.max(0, topBacklog));
    const lines = shown.map(
      (t, i) => `${i + 1}. [${t.id ?? i + 1}] ${t.title ?? "(untitled)"}${t.notes ? ` — ${t.notes}` : ""}`,
    );
    sections.push(`Open backlog (top ${shown.length} of ${open.length}):\n${lines.join("\n")}`);
  }
  if (context) {
    sections.push(`Recently working on:\n${context}`);
  }

  const directive = [
    "Decide the SINGLE next right thing to do right now toward the above, and do it.",
    "Prefer the smallest action that genuinely moves things forward.",
    "If you complete a backlog item, mark it done.",
    "When you finish, append a one-line note of what you did and what's next to the working context so the next tick has continuity.",
  ].join(" ");

  return `${sections.join("\n\n")}\n\n${directive}`;
}

/** Open (not-done) backlog items from a queue array. */
export function openItems(queue) {
  return (Array.isArray(queue) ? queue : []).filter((t) => t && t.status !== "done");
}

/** Strip HTML comments (editor hints) and trim, so placeholders never pollute the prompt. */
export function cleanText(s) {
  return String(s ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

/**
 * Decide whether a tick should fire now. Pure: caller supplies `now` (Date) and
 * the running daily tick count.
 * @returns {{run:boolean, reason:string}}
 */
export function shouldRunNow(config, state, now, ticksToday = 0) {
  const mission = cleanText(state?.mission);
  if (!mission && openItems(state?.queue).length === 0) {
    return { run: false, reason: "idle: no mission and empty backlog" };
  }
  // null/undefined = unlimited (Number(null) would be 0 and cap everything); coerce
  // only actual values so a string "24" still enforces the cap.
  const cap = config?.maxTicksPerDay == null ? NaN : Number(config.maxTicksPerDay);
  if (Number.isFinite(cap) && ticksToday >= cap) {
    return { run: false, reason: `daily budget reached (${ticksToday}/${cap})` };
  }
  if (config?.quietHours && inQuietHours(config.quietHours, now)) {
    return { run: false, reason: "within quiet hours" };
  }
  return { run: true, reason: "ok" };
}

/** True when `now`'s hour falls in [start, end), handling a midnight wrap. */
export function inQuietHours(quiet, now) {
  const start = Number(quiet?.start);
  const end = Number(quiet?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) {
    return false;
  }
  const h = now.getHours();
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/** Seconds to wait before the next tick (defaults to 30 min). */
export function nextTickDelay(config) {
  const s = Number(config?.intervalSeconds);
  return Number.isFinite(s) && s > 0 ? s : 1800;
}

/** Reset the daily counter when the date rolls over. Pure. */
export function rolloverIfNewDay(runtime, today) {
  if (!runtime || runtime.date !== today) {
    return { date: today, count: 0 };
  }
  return runtime;
}

// ---------------------------------------------------------------------------
// I/O (not unit-tested directly)
// ---------------------------------------------------------------------------

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Read the three goal-state files from a directory into a state object. */
export async function readState(dir) {
  const mission = await readText(join(dir, "mission.md"));
  const context = await readText(join(dir, "context.md"));
  let queue = [];
  try {
    queue = JSON.parse((await readText(join(dir, "queue.json"))) || "[]");
  } catch {
    queue = [];
  }
  return { mission, context, queue: Array.isArray(queue) ? queue : [] };
}

async function loadConfig() {
  for (const name of ["config.json", "config.example.json"]) {
    const raw = await readText(join(HERE, name));
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new Error(`heartbeat: ${name} is not valid JSON: ${err.message}`);
      }
    }
  }
  return {};
}

async function loadRuntime(dir, today) {
  let rt = {};
  try {
    rt = JSON.parse((await readText(join(dir, RUNTIME_FILE))) || "{}");
  } catch {
    rt = {};
  }
  return rolloverIfNewDay(rt, today);
}

async function saveRuntime(dir, runtime) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, RUNTIME_FILE), JSON.stringify(runtime, null, 2));
}

async function dispatch(prompt, config) {
  const type = config?.trigger?.type ?? "command";
  const mod = await import(new URL(`./trigger/${type}.mjs`, import.meta.url));
  return mod.dispatch(prompt, config.trigger ?? {});
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

function todayStr(now) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function tick({ config, stateDir, dryRun, log }) {
  const now = new Date();
  const state = await readState(stateDir);
  let runtime = await loadRuntime(stateDir, todayStr(now));

  const verdict = shouldRunNow(config, state, now, runtime.count);
  if (!verdict.run) {
    log(`skip tick — ${verdict.reason}`);
    return;
  }

  const prompt = composePrompt(state, { topBacklog: config.topBacklog });
  if (!prompt) {
    log("skip tick — nothing to pursue");
    return;
  }

  if (dryRun) {
    log("DRY RUN — prompt that would be sent:\n" + prompt);
    return;
  }

  log("dispatching next-right-thing tick to gateway…");
  await dispatch(prompt, config);
  runtime = { ...runtime, count: runtime.count + 1 };
  await saveRuntime(stateDir, runtime);
  log(`tick dispatched (${runtime.count}/${config.maxTicksPerDay ?? "∞"} today)`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const once = args.has("--once");
  const config = await loadConfig();
  const dryRun = args.has("--dry-run") || (config.dryRun ?? false);
  const stateDir = config.stateDir ? join(HERE, config.stateDir) : DEFAULT_STATE_DIR;
  const log = (m) => console.log(`[nrt-heartbeat ${new Date().toISOString()}] ${m}`);

  if (dryRun) log("dry-run mode: no prompts will be sent");

  do {
    try {
      await tick({ config, stateDir, dryRun, log });
    } catch (err) {
      log(`tick error: ${err.message}`);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, nextTickDelay(config) * 1000));
  } while (true);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
