const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
const MAX_APPROVAL_DESCRIPTION_LENGTH = 256;
const MAX_REFLECTION_INSTRUCTION_LENGTH = 1024;
const MAX_RUN_CONTEXT_INSTRUCTION_LENGTH = 1400;
const DEFAULT_RUN_CONTEXT_INSTRUCTION = [
  "Next Right Thing protocol is active for this run.",
  "Before acting, choose the smallest useful next step that moves the active goal forward.",
  "Prefer reversible, evidence-producing actions; ask for approval before destructive, production, publishing, messaging, auth, billing, or security-sensitive actions.",
  "Use OpenClaw-covered tools for risky operations so plugin approvals can fire; if a native model tool would bypass OpenClaw approval, pause and ask to route that action through a covered tool/runtime.",
  "Before finalizing, state the concrete evidence that the goal is done; if it is not done, name the next right thing instead of claiming completion.",
].join(" ");
const DEFAULT_RUNTIME_COVERAGE_BLOCK_MESSAGE =
  "Next Right Thing blocked this run because OpenClaw did not expose a hook-covered tool runtime to the plugin. Route the model through OpenClaw's embedded runtime or enable a native hook relay before running agent tools.";
// Distinct from the completion-audit key so the host never conflates the two
// `before_agent_finalize` revise paths (audit vs built-in reflection).
const REFLECTION_IDEMPOTENCY_KEY = "next-right-thing-reflection";

export const HARD_EFFECTS = new Set([
  "spend_money",
  "publish",
  "send_message",
  "contact_people",
  "delete_data",
  "overwrite_data",
  "rotate_credentials",
  "execute_remote_code",
  "mutate_production",
  "change_auth",
  "change_billing",
  "change_permissions",
  "legal_exposure",
  "medical_exposure",
  "financial_exposure",
  "employment_exposure",
  "privacy_exposure",
  "security_exposure",
]);

// Effect classes severe enough to score a tool call as `critical` (risk 5) rather than
// a plain `warning`: irreversible data loss/overwrite, production mutation, and the
// auth/privilege changes that enable privilege escalation or auth tampering.
const HIGH_SEVERITY_EFFECTS = new Set([
  "delete_data",
  "overwrite_data",
  "mutate_production",
  "change_auth",
  "change_permissions",
  "execute_remote_code",
]);

export const EXEC_TOOL_NAMES = new Set([
  "exec",
  "code_mode_exec",
  "bash",
  "shell",
  "sh",
  "zsh",
  "powershell",
  "pwsh",
  "terminal",
  "run",
  "run_command",
  "run_shell_command",
]);

// Single-word tokens that mark a tool name as an exec/shell runner. Matched against
// the name split on any non-alphanumeric separator, so underscored and namespaced
// names (exec_command, shell_command, functions.exec_command) are recognized too.
export const EXEC_TOOL_KEYWORDS = new Set([
  "exec",
  "bash",
  "shell",
  "sh",
  "zsh",
  "powershell",
  "pwsh",
  "terminal",
  "cmd",
  "command",
  "run",
]);

// Single-word tokens that mark a tool as a database/query tool, so destructive SQL
// is gated for them (and for exec runners) without false-firing on arbitrary tools
// that merely carry SQL as text (e.g. a web search about "DELETE FROM"). Deliberately
// excludes generic tokens like "query" that appear in non-DB tool names (search_query).
export const DB_TOOL_KEYWORDS = new Set([
  "sql",
  "db",
  "database",
  "databases",
  "postgres",
  "postgresql",
  "pg",
  "mysql",
  "mariadb",
  "sqlite",
  "mssql",
  "tsql",
  "plsql",
  "oracle",
  "cockroach",
  "cockroachdb",
  "snowflake",
  "bigquery",
  "redshift",
  "clickhouse",
  "duckdb",
  "d1",
  "supabase",
  "planetscale",
  "neon",
  "prisma",
  "knex",
  "sequelize",
  "drizzle",
  "datasette",
]);

export const REVIEW_ROLES = new Set(["critic", "verifier", "security", "fact_checker", "memory_curator"]);
const REVIEW_ROLE_PRIORITY = ["critic", "security", "fact_checker", "verifier", "memory_curator"];
const DEFAULT_BLOCKED_RUNTIME_IDS = [];
const DEFAULT_BLOCKED_PROVIDER_IDS = [];

// One short self-review directive per review lens, used to compose the reflective
// finalize instruction so the agent's contemplation is multi-perspective.
export const REVIEW_ROLE_PROMPTS = {
  critic: "challenge whether this is really the next right thing, or just the first thing",
  security: "re-examine any auth, permission, secret, or data-exposure risk you introduced",
  fact_checker: "verify each claim you are about to make against the evidence you gathered",
  verifier: "confirm the stated done-criteria are demonstrably met, not just plausible",
  memory_curator: "note what should be recorded or remembered for next time",
};

const PRODUCTION_PATTERNS = [
  /\bvercel\b.*(?:^|\s)--prod\b/i,
  /\bwrangler\b.*\bdeploy\b/i,
  /\bkubectl\b.*\b(apply|delete|rollout|scale)\b/i,
  /\bflyctl\b.*\bdeploy\b/i,
  /\brailway\b.*\b(up|deploy)\b/i,
  /\bterraform\b.*\b(apply|destroy)\b/i,
];

const DESTRUCTIVE_PATTERNS = [
  // File deletion is destructive even when it is a single target. Gate `rm`
  // unless it is plainly a help invocation.
  /(?:^|[\s"';&|])rm(?:\.exe)?\b(?!\s+(?:--help|-h)\b)(?=\s+\S)/i,
  /\brm\b(?=.*(?:\s-[a-z]*r|\s--recursive))/i,
  /\b(?:Remove-Item|del|erase|unlink)\b(?![\s\S]*\s-(?:WhatIf|Confirm)\b)/i,
  /\bgit\b.*\breset\b.*\s--hard\b/i,
  /\bgit\b.*\bclean\b.*(?:\s-[a-z]*f|\s--force\b)/i,
  /\bgit\b.*\bpush\b.*(?:\s-[a-z]*f|\s--force(?:-with-lease)?\b|\s\+\S)/i,
  /\bcurl\b.*(?:\s-X\s*DELETE|\s--request[=\s]\s*DELETE)\b/i,
  // Raw-disk / filesystem / secure-erase primitives — irreversible data destruction
  // that is not spelled with `rm` at all.
  /\bdd\b(?=[\s\S]*\bof=)/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\b(?:shred|wipefs|blkdiscard)\b/i,
  /\bfind\b[\s\S]*\s-delete\b/i,
  // truncate shrinks/zeroes a file; cover spaced and compact size forms (`-s 0`, `-s0`, `--size=0`).
  /\btruncate\b\s+(?:-s|--size)/i,
  // Truncation-via-redirect of a data file (e.g. `cat /dev/null > app.sqlite`).
  />\s*\S*\.(?:db|sqlite3?|sql|dump|bak)\b/i,
  // Redirect to a raw block device (e.g. `dd if=/dev/zero > /dev/sda`, with no of=) —
  // an allowlist of device names so benign `> /dev/null` / `> /dev/stdout` never gate.
  />\s*\/dev\/(?:sd[a-z]|nvme\d|vd[a-z]|hd[a-z]|mmcblk\d|xvd[a-z]|disk\d|loop\d)/i,
];

// Destructive/mutating SQL by the HARD_EFFECT each statement implies. Tool-agnostic:
// dedicated database tools (e.g. MCP execute_sql / query tools) carry SQL in params
// rather than a shell command, so these are scanned for database- and exec-like tools
// (not arbitrary tools that merely mention SQL as text). DROP TABLE/DELETE/TRUNCATE
// are not the only destructive shapes — mass UPDATE, privilege GRANT/REVOKE, and
// role/user (auth) changes mutate just as irreversibly and must gate too.
const SQL_EFFECT_PATTERNS = [
  [/\bDROP\s+(?:TABLE|DATABASE|SCHEMA|VIEW|INDEX|SEQUENCE)\b/i, "delete_data"],
  [/\bDELETE\s+FROM\b/i, "delete_data"],
  [/\bTRUNCATE\s+(?:TABLE\s+)?\w/i, "delete_data"],
  [/\bUPDATE\s+\S+(?:\s+(?:AS\s+)?\S+)?\s+SET\b/i, "overwrite_data"],
  [/\bALTER\s+TABLE\b[\s\S]*\bDROP\b/i, "overwrite_data"],
  // Anchor to statement structure (ON/TO/FROM) so a bare "grant"/"revoke" token in an
  // exec command (e.g. `aws kms create-grant`, `./grant-access.sh`) does not false-fire.
  [/\bGRANT\b[\s\S]*\b(?:ON|TO)\b/i, "change_permissions"],
  [/\bREVOKE\b[\s\S]*\b(?:ON|FROM)\b/i, "change_permissions"],
  [/\b(?:CREATE|DROP|ALTER)\s+(?:ROLE|USER|GROUP)\b/i, "change_auth"],
];

// Piping fetched or decoded content straight into a shell interpreter runs opaque,
// unreviewed code (the classic `curl … | sh` supply-chain shape). The gate cannot see
// what the piped payload does, so the pipe-into-a-shell itself is the risk to surface.
// Anchored to the pipe so a shell name merely appearing as an argument does not fire.
const REMOTE_EXEC_PATTERNS = [
  // `curl … | sh`, `wget … | bash`, `fetch … | zsh`, optionally via sudo. Piping
  // anything into a shell always executes it, so the pipe-into-a-shell is the risk.
  /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|fish)\b/i,
  // Process-substitution into a shell: `bash <(curl …)`, `sh <(wget …)`.
  /\b(?:sh|bash|zsh|dash|ksh|fish)\s+<\(/i,
  // A network fetch piped into a *bare* language interpreter, where stdin becomes the
  // program: `curl … | python`, `wget … | node`. Requires the interpreter to be
  // terminal (end of command, or followed only by a bare `-`) so that piping fetched
  // *data* into a tool — `curl … | python -m json.tool`, `… | node app.js` — is left
  // alone and the false-positive rate stays at zero.
  /\b(?:curl|wget|fetch)\b[\s\S]*\|\s*(?:sudo\s+)?(?:python[0-9.]*|node|deno|bun|perl|ruby|php|Rscript)\s*(?:$|[|;&]|-\s|-$)/i,
  // A shell `-c` that runs a command-substitution which fetches: `bash -c "$(curl …)"`.
  /\b(?:sh|bash|zsh|dash|ksh)\b[\s\S]*\s-c\b[\s\S]*\$\([\s\S]*\b(?:curl|wget|fetch)\b/i,
  // eval / source / `.` of a substitution that fetches — fetched content run as code:
  // `eval "$(curl …)"`, `source <(curl …)`, `. <(wget …)`.
  /\beval\b[\s\S]*\$\([\s\S]*\b(?:curl|wget|fetch)\b/i,
  /(?:^|[\s;&|])(?:source\s+|\.\s+)<\([\s\S]*\b(?:curl|wget|fetch)\b/i,
  // Decode-then-execute: `base64 -d | sh`, `openssl … | bash` (payload is hidden).
  /\bbase64\b[\s\S]*\s-{1,2}d\w*\b[\s\S]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|fish)\b/i,
];

const PUBLISH_PATTERNS = [
  /\bnpm\b.*\bpublish\b/i,
  /\bpypi\b/i,
  /\btwine\b.*\bupload\b/i,
  /\bgh\b.*\brelease\b.*\b(create|upload)\b/i,
];

const SECRET_PATTERNS = [
  /\bOPENAI_API_KEY\b/i,
  /\bANTHROPIC_API_KEY\b/i,
  /\bAWS_SECRET_ACCESS_KEY\b/i,
  /\bAWS_ACCESS_KEY_ID\b/i,
  /\bGITHUB_TOKEN\b/i,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/i,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
  /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bglpat-[0-9A-Za-z_-]{20}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/i,
];

function stringifyParams(params) {
  try {
    return JSON.stringify(params ?? {});
  } catch {
    return String(params ?? "");
  }
}

function eventParams(event) {
  return event?.params ?? event?.arguments ?? event?.input ?? {};
}

function commandText(event) {
  const params = eventParams(event);
  return String(params.cmd ?? params.command ?? params.input ?? params.script ?? stringifyParams(params));
}

// Recursively join all leaf string/number/boolean values in params with spaces, so a
// command or SQL statement split across keys/arrays (e.g. {cmd:"DELETE",args:["FROM","x"]})
// reads as one contiguous string without the JSON key names wedged between tokens.
function flattenParamValues(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const v of value) flattenParamValues(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) flattenParamValues(v, out);
  }
  return out;
}

function anyPattern(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

function globalPattern(pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function redactSecrets(text) {
  let redacted = String(text ?? "");
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(globalPattern(pattern), "[redacted]");
  }
  return redacted;
}

function boundedText(text, maxLength) {
  const value = String(text ?? "");
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeEffects(effects) {
  const values = Array.isArray(effects) ? effects : effects == null ? [] : [effects];
  return [...new Set(values.map((effect) => String(effect).trim()).filter(Boolean))].sort();
}

function normalizeBoolean(value, fallback) {
  if (value == null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return Boolean(value);
}

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeReviewRoles(roles) {
  const values = Array.isArray(roles) ? roles : roles == null ? [] : [roles];
  const normalized = [];
  for (const value of values) {
    const role = String(value ?? "").trim();
    if (!role) {
      continue;
    }
    if (!REVIEW_ROLES.has(role)) {
      throw new TypeError(`unknown review role: ${role}`);
    }
    if (!normalized.includes(role)) {
      normalized.push(role);
    }
  }
  return normalized;
}

function normalizeStringList(values, fallback = []) {
  const raw = Array.isArray(values) ? values : values == null ? fallback : [values];
  return [
    ...new Set(
      raw
        .map((value) => String(value ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function readNestedId(value, path) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : undefined;
}

function collectRuntimeCoverageIdentity(event = {}, ctx = {}) {
  const sources = [event, ctx, event.context, event.ctx].filter(Boolean);
  const readAny = (paths) =>
    normalizeStringList(
      sources.flatMap((source) => paths.map((path) => readNestedId(source, path))),
      [],
    );

  return {
    runtimeIds: readAny([
      ["runtimeId"],
      ["agentRuntimeId"],
      ["agentRuntime"],
      ["agentRuntime", "id"],
      ["runtime", "id"],
    ]),
    providerIds: readAny([
      ["provider"],
      ["providerId"],
      ["modelProviderId"],
      ["model", "provider"],
    ]),
    modelIds: readAny([
      ["model"],
      ["modelId"],
      ["model", "id"],
    ]),
  };
}

function callPluginConfig(event = {}) {
  return event?.context?.pluginConfig ?? event?.context?.config ?? event?.config ?? {};
}

function runtimeCoverageBlock(reason, message, identity, extra = {}) {
  return {
    outcome: "block",
    reason,
    message: message || DEFAULT_RUNTIME_COVERAGE_BLOCK_MESSAGE,
    category: "runtime_coverage",
    metadata: {
      ...(identity.runtimeIds.length ? { runtimeIds: identity.runtimeIds } : {}),
      ...(identity.providerIds.length ? { providerIds: identity.providerIds } : {}),
      ...(identity.modelIds.length ? { modelIds: identity.modelIds } : {}),
      ...extra,
    },
  };
}

/**
 * Confirm that the Next Right Thing layer is present before model inference.
 * This is an opt-in layer: it does nothing unless `enforce` is explicitly set.
 * When enforced it is still model-agnostic by default (any runtime that reaches
 * the hook can run); operators can additionally opt into strict blocking for
 * specific runtime/provider ids, or require exposed identity, when they need
 * hard tool-coverage enforcement.
 *
 * @param {object} event - The `before_agent_run` event.
 * @param {object} [ctx] - The OpenClaw hook context.
 * @param {object} [options] - Runtime coverage policy.
 * @returns {object} A pass/block input-gate decision.
 */
export function beforeAgentRunDecision(event = {}, ctx = {}, options = {}) {
  if (!normalizeBoolean(options.enforce, false)) {
    return { outcome: "pass" };
  }

  const identity = collectRuntimeCoverageIdentity(event, ctx);
  const blockedRuntimeIds = normalizeStringList(options.blockedRuntimeIds, DEFAULT_BLOCKED_RUNTIME_IDS);
  const blockedProviderIds = normalizeStringList(options.blockedProviderIds, DEFAULT_BLOCKED_PROVIDER_IDS);
  const blockedRuntimeId = identity.runtimeIds.find((runtimeId) => blockedRuntimeIds.includes(runtimeId));
  if (blockedRuntimeId) {
    return runtimeCoverageBlock(
      `runtime ${blockedRuntimeId} is not covered by before_tool_call`,
      options.message,
      identity,
      { blockedRuntimeId },
    );
  }

  const blockedProviderId = identity.providerIds.find((providerId) => blockedProviderIds.includes(providerId));
  if (blockedProviderId) {
    return runtimeCoverageBlock(
      `provider ${blockedProviderId} is not covered by before_tool_call`,
      options.message,
      identity,
      { blockedProviderId },
    );
  }

  const hasIdentity = identity.runtimeIds.length > 0 || identity.providerIds.length > 0 || identity.modelIds.length > 0;
  if (!hasIdentity && !normalizeBoolean(options.allowUnidentifiedRuntime, true)) {
    return runtimeCoverageBlock("runtime coverage identity is missing", options.message, identity);
  }

  return { outcome: "pass" };
}

/**
 * Inject the model-agnostic Next Right Thing operating context before prompt
 * construction so runtimes without finalize-hook support still receive the
 * protocol. Opt-in: returns undefined unless `enabled` is explicitly set.
 *
 * @param {object} event - The `before_prompt_build` event.
 * @param {object} [options] - Run-context policy.
 * @returns {object|undefined} A prompt-build mutation, or undefined when off.
 */
export function beforePromptBuildDecision(event = {}, options = {}) {
  if (!normalizeBoolean(options.enabled, false)) {
    return undefined;
  }
  const instruction = boundedText(
    redactSecrets(String(options.instruction ?? DEFAULT_RUN_CONTEXT_INSTRUCTION)),
    MAX_RUN_CONTEXT_INSTRUCTION_LENGTH,
  );
  if (!instruction.trim()) {
    return undefined;
  }
  return {
    prependSystemContext: instruction,
  };
}

function defaultReviewRoles(candidate) {
  const roles = [];
  const effects = normalizeEffects(candidate.effects);
  if (normalizeNumber(candidate.risk, 0) >= 3) {
    roles.push("critic");
  }
  if (effects.includes("security_exposure") || effects.includes("change_auth") || effects.includes("change_permissions")) {
    roles.push("security");
  }
  if (candidate.needs_fact_check) {
    roles.push("fact_checker");
  }
  if (normalizeNumber(candidate.evidence_gain, 0) >= 3) {
    roles.push("verifier");
  }
  return roles;
}

function mergeReviewRoles(defaults, requested) {
  const present = new Set([...defaults, ...requested]);
  return REVIEW_ROLE_PRIORITY.filter((role) => present.has(role));
}

/**
 * Infer the set of side effects a tool call would have by inspecting its name,
 * kind, and parameters (destructive shell commands, production deploys, publishing,
 * outbound messaging, billing/financial actions, and secret exposure).
 *
 * @param {object} event - The `before_tool_call` event ({ toolName, toolKind, params }).
 * @returns {string[]} A sorted, de-duplicated list of inferred effect identifiers.
 */
export function inferEffectsFromToolCall(event) {
  const toolName = String(event?.toolName ?? event?.name ?? event?.tool?.name ?? "");
  const toolKind = String(event?.toolKind ?? event?.kind ?? event?.ctx?.toolKind ?? "");
  const text = commandText(event);
  const params = eventParams(event);
  const allParamsText = stringifyParams(params);
  // Normalize JSON punctuation AND escaped whitespace (\n, \t, \r) to spaces, so a
  // command/SQL split across keys or an argv array, or carried as a multiline string,
  // still reads as spaced text the patterns can match.
  const normalizedParams = allParamsText.replace(/\\[ntr]/g, " ").replace(/[{}[\],:"]/g, " ");
  // Param VALUES joined by spaces — catches a command/SQL split across a primary field
  // and an args array (the JSON key names are dropped, unlike normalizedParams).
  const valuesText = flattenParamValues(params).join(" ");
  const lowerToolName = toolName.toLowerCase();
  const effects = new Set();

  // Scan the whole params object, not just the command string, so a secret in
  // headers/body/env alongside an innocuous command is still treated as exposure.
  if (anyPattern(SECRET_PATTERNS, text) || anyPattern(SECRET_PATTERNS, allParamsText)) {
    effects.add("security_exposure");
  }

  // Split on non-alphanumerics, ACRONYM runs (DBExec → DB Exec, SQLQuery → SQL Query),
  // and camelCase boundaries (runCommand → run Command) so compound/acronym/namespaced
  // tool names all tokenize to recognizable keywords.
  const toolNameTokens = toolName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const looksLikeExec =
    EXEC_TOOL_NAMES.has(toolName) ||
    toolKind.includes("exec") ||
    toolNameTokens.some((token) => EXEC_TOOL_KEYWORDS.has(token));
  const looksLikeDatabase =
    toolKind.includes("sql") ||
    toolKind.includes("database") ||
    toolNameTokens.some((token) => DB_TOOL_KEYWORDS.has(token));

  // Destructive SQL is gated for database/query tools (which carry it in params) and
  // for exec runners, but not for arbitrary tools that only carry SQL as text — that
  // would false-fire on, e.g., a web search about "DELETE FROM". The normalized copy
  // catches SQL split across argv elements or carried as a multiline string.
  if (looksLikeExec || looksLikeDatabase) {
    const sqlTexts = [text, allParamsText, normalizedParams, valuesText];
    for (const [pattern, effect] of SQL_EFFECT_PATTERNS) {
      if (sqlTexts.some((sqlText) => pattern.test(sqlText))) {
        effects.add(effect);
      }
    }
  }

  if (looksLikeExec) {
    // Scan the command string, the serialized params (object-valued input/script
    // payloads collapse to "[object Object]" in commandText), and the normalized copy
    // (so structured argv like {cmd:"rm",args:["-rf","x"]} reads as a spaced command).
    const execText = `${text}\n${allParamsText}\n${normalizedParams}\n${valuesText}`;
    if (anyPattern(PRODUCTION_PATTERNS, execText)) {
      effects.add("mutate_production");
    }
    if (anyPattern(DESTRUCTIVE_PATTERNS, execText)) {
      effects.add("delete_data");
    }
    if (anyPattern(REMOTE_EXEC_PATTERNS, execText)) {
      effects.add("execute_remote_code");
    }
    if (anyPattern(PUBLISH_PATTERNS, execText)) {
      effects.add("publish");
    }
  }

  // Name-based effect inference matches the LOWERCASED tool name, so the dominant MCP
  // convention (mcp__Gmail__, mcp__Slack__, mcp__Stripe__) is covered, not just lowercase.
  if (lowerToolName.includes("email") || lowerToolName.includes("gmail") || lowerToolName.includes("outlook")) {
    effects.add("send_message");
  }
  if (lowerToolName.includes("slack") || lowerToolName.includes("discord") || lowerToolName.includes("telegram")) {
    effects.add("send_message");
  }
  if (lowerToolName.includes("billing") || lowerToolName.includes("stripe")) {
    effects.add("financial_exposure");
  }
  if (lowerToolName.includes("deploy")) {
    effects.add("mutate_production");
  }

  return [...effects].sort();
}

/**
 * Build a scored "candidate" for a tool call: its inferred effects plus risk,
 * irreversibility, approval requirement, and review roles. Any field may be
 * overridden by the caller; inferred effects drive sensible defaults otherwise.
 *
 * @param {object} event - The `before_tool_call` event.
 * @param {object} [overrides] - Explicit candidate fields that override inference.
 * @returns {object} The normalized candidate object.
 */
export function buildToolCandidate(event, overrides = {}) {
  const inferredEffects = inferEffectsFromToolCall(event);
  const effects = normalizeEffects(overrides.effects ?? inferredEffects);
  const highSeverity = effects.some((effect) => HIGH_SEVERITY_EFFECTS.has(effect));
  const risk = highSeverity ? 5 : effects.length > 0 ? 4 : 1;
  const irreversibility = highSeverity ? 4 : 1;
  const approvalRequired = effects.some((effect) => HARD_EFFECTS.has(effect));
  const toolName = String(event?.toolName ?? event?.name ?? "unknown");
  const candidate = {
    id: overrides.id ?? `${event?.toolCallId ?? event?.runId ?? event?.toolName ?? event?.name ?? "tool"}-candidate`,
    title: overrides.title ?? `Run tool: ${toolName}`,
    description: overrides.description ?? redactSecrets(commandText(event)).slice(0, 500),
    value: overrides.value ?? 3,
    urgency: overrides.urgency ?? 2,
    unblock_power: overrides.unblock_power ?? 2,
    evidence_gain: overrides.evidence_gain ?? 2,
    learning_value: overrides.learning_value ?? 1,
    risk: overrides.risk ?? risk,
    cost: overrides.cost ?? 1,
    irreversibility: overrides.irreversibility ?? irreversibility,
    uncertainty: overrides.uncertainty ?? 2,
    effects,
    approval_required: normalizeBoolean(overrides.approval_required, approvalRequired),
    moves_goal: normalizeBoolean(overrides.moves_goal, true),
    needs_fact_check: normalizeBoolean(overrides.needs_fact_check, false),
  };
  candidate.review_roles = mergeReviewRoles(defaultReviewRoles(candidate), normalizeReviewRoles(overrides.review_roles));
  return candidate;
}

/**
 * Determine why a candidate requires human approval, if at all.
 *
 * @param {object} candidate - A candidate from {@link buildToolCandidate}.
 * @returns {string[]} Human-readable approval reasons; empty if no approval is needed.
 */
export function approvalReasons(candidate) {
  const reasons = [];
  if (!candidate || typeof candidate !== "object") {
    return ["candidate is malformed"];
  }
  const effects = normalizeEffects(candidate.effects);
  if (normalizeBoolean(candidate.approval_required, false)) {
    reasons.push("candidate marked approval_required");
  }
  for (const effect of effects) {
    if (HARD_EFFECTS.has(effect)) {
      reasons.push(`hard effect: ${effect}`);
    }
  }
  if (normalizeNumber(candidate.irreversibility, 0) >= 4 && normalizeNumber(candidate.risk, 0) >= 3) {
    reasons.push("high irreversibility with material risk");
  }
  if (normalizeNumber(candidate.risk, 0) >= 4 && normalizeNumber(candidate.uncertainty, 0) >= 3) {
    reasons.push("high risk with high uncertainty");
  }
  return [...new Set(reasons)];
}

/**
 * Compute the `before_tool_call` hook decision: block a call that does not move
 * the goal forward, request bounded approval for risky effects, or allow silently.
 *
 * @param {object} event - The `before_tool_call` event.
 * @param {object} [options] - Policy options (candidateOverrides, title, timeoutMs, etc.).
 * @returns {object|undefined} A hook decision, or `undefined` to allow without intervention.
 */
export function beforeToolCallDecision(event, options = {}) {
  const candidate = buildToolCandidate(event, options.candidateOverrides ?? {});
  const reasons = approvalReasons(candidate);
  if (normalizeBoolean(candidate.moves_goal, true) === false) {
    return {
      block: true,
      blockReason: "Next Right Thing rejected a tool call that does not move the active goal forward.",
    };
  }
  if (reasons.length === 0) {
    return undefined;
  }

  return {
    requireApproval: {
      title: options.title ?? `Approve ${candidate.title}`,
      description: boundedText([
        candidate.description ? `Action: ${redactSecrets(candidate.description)}` : "",
        `Reasons: ${reasons.join("; ")}`,
        `Effects: ${normalizeEffects(candidate.effects).join(", ") || "none"}`,
      ]
        .filter(Boolean)
        .join("\n"), MAX_APPROVAL_DESCRIPTION_LENGTH),
      severity: normalizeNumber(candidate.risk, 0) >= 5 ? "critical" : "warning",
      timeoutMs: options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
      timeoutBehavior: options.timeoutBehavior ?? "deny",
      allowedDecisions: options.allowedDecisions ?? ["allow-once", "deny"],
      pluginId: options.pluginId ?? "next-right-thing",
      onResolution: options.onResolution,
    },
  };
}

function missingAuditRequirements(auditResult) {
  if (!auditResult || typeof auditResult !== "object") {
    return ["audit result: malformed"];
  }
  if (!("requirements" in auditResult)) {
    return [];
  }
  if (!Array.isArray(auditResult.requirements)) {
    return ["requirements: malformed"];
  }
  return auditResult.requirements
    .filter((item) => !item || typeof item !== "object" || item.status !== "proven")
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "requirement: malformed";
      }
      return `${item.requirement ?? "unknown requirement"}: ${item.status ?? "unknown"}`;
    });
}

/**
 * Translate a completion-audit result into a `before_agent_finalize` decision.
 * Returns a "revise" instruction listing unproven requirements when the audit is
 * incomplete, or `undefined` when completion is proven.
 *
 * @param {object} auditResult - The audit result ({ status, requirements }).
 * @param {object} [options] - Overrides for the revise instruction / retry policy.
 * @returns {object|undefined} A revise decision, or `undefined` when complete.
 */
export function finalizeDecisionFromAudit(auditResult, options = {}) {
  if (!auditResult || auditResult.status === "complete") {
    return undefined;
  }

  const missing = missingAuditRequirements(auditResult);

  return {
    action: "revise",
    reason: "Completion is not yet proven by the Next Right Thing audit.",
    retry: {
      instruction:
        options.instruction ??
        `Do not claim completion yet. Gather or record stronger evidence for: ${missing.join("; ") || "unproven requirements"}.`,
      idempotencyKey: options.idempotencyKey ?? "next-right-thing-completion-audit",
      maxAttempts: options.maxAttempts ?? 1,
    },
  };
}

/**
 * Built-in reflective deliberation for `before_agent_finalize`. Unlike
 * {@link finalizeDecisionFromAudit} (which needs an external audit), this runs with
 * no dependencies: on the agent's finalize attempt it returns one `revise` that makes
 * the model restate its goal, prove the work is actually done, name the next right
 * thing if not, and self-review through the configured review lenses. A stable
 * idempotency key plus `maxAttempts` (default 1) make it a one-shot, so it asks once
 * and then lets finalize proceed — never an infinite loop. Opt-in: returns undefined
 * unless `enabled` is explicitly set.
 *
 * @param {object} event - The `before_agent_finalize` event (unused today; kept for parity).
 * @param {object} [options] - { enabled, reviewRoles, instruction, idempotencyKey, maxAttempts }.
 * @returns {object|undefined} A revise decision, or `undefined` to allow finalize.
 */
export function reflectiveFinalizeDecision(event, options = {}) {
  if (!normalizeBoolean(options.enabled, false)) {
    return undefined;
  }

  const lenses = mergeReviewRoles(["critic", "verifier"], normalizeReviewRoles(options.reviewRoles));
  const lensText = lenses.map((role) => `${role} (${REVIEW_ROLE_PROMPTS[role]})`).join("; ");

  const instruction =
    options.instruction ??
    [
      "Before you finalize, do not claim completion yet. In your next turn:",
      "(1) restate the active goal in one sentence;",
      "(2) state the concrete evidence that it is actually done;",
      "(3) if it is not fully done, name at least one next right thing and do it;",
      `(4) self-review through these lenses — ${lensText}.`,
      "Then either finalize with that evidence, or take the next action.",
    ].join(" ");

  return {
    action: "revise",
    reason: "Pause before finalizing: confirm this is the next right thing.",
    retry: {
      instruction: boundedText(redactSecrets(instruction), MAX_REFLECTION_INSTRUCTION_LENGTH),
      idempotencyKey: options.idempotencyKey ?? REFLECTION_IDEMPOTENCY_KEY,
      maxAttempts: normalizeNumber(options.maxAttempts, 1),
    },
  };
}

/**
 * Create the OpenClaw plugin entry. The `before_tool_call` approval gate is
 * always registered (the core, no permission needed). The run context
 * (`before_prompt_build`), runtime preflight (`before_agent_run`), and
 * `before_agent_finalize` deliberation gate are opt-in (default off) and register
 * only when enabled; when reflection is enabled it composes ahead of any supplied
 * `loadCompletionAudit`. A wired `loadCompletionAudit` also registers the finalize
 * gate on its own.
 *
 * @param {Function} definePluginEntry - The OpenClaw `definePluginEntry` factory.
 * @param {object} [options] - Plugin metadata, tool/finalize policy, reflection, and audit loader.
 * @returns {object} The plugin entry produced by `definePluginEntry`.
 */
export function createNextRightThingPlugin(definePluginEntry, options = {}) {
  if (typeof definePluginEntry !== "function") {
    throw new TypeError("definePluginEntry must be provided by the OpenClaw plugin runtime.");
  }

  return definePluginEntry({
    id: options.pluginId ?? "next-right-thing",
    name: options.name ?? "Next Right Thing",
    description:
      options.description ??
      "Adds the Next Right Thing approval gate (always on), with opt-in run context, runtime coverage, and finalize reflection.",
    configSchema:
      options.configSchema ?? {
        type: "object",
        additionalProperties: false,
        properties: {
          approvalTimeoutMs: { type: "integer", minimum: 0 },
          reflection: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean", default: false },
              reviewRoles: {
                type: "array",
                items: {
                  type: "string",
                  enum: ["critic", "verifier", "security", "fact_checker", "memory_curator"],
                },
              },
              maxAttempts: { type: "integer", minimum: 1, default: 1 },
            },
          },
          runContext: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean", default: false },
              instruction: { type: "string" },
            },
          },
          runtimeCoverage: {
            type: "object",
            additionalProperties: false,
            properties: {
              enforce: { type: "boolean", default: false },
              allowUnidentifiedRuntime: { type: "boolean", default: true },
              blockedRuntimeIds: { type: "array", items: { type: "string" } },
              blockedProviderIds: { type: "array", items: { type: "string" } },
              message: { type: "string" },
            },
          },
        },
      },
    register(api) {
      // Honor the user-facing `approvalTimeoutMs` config knob by threading it into
      // the tool policy. Per-call plugin config wins over plugin-level config, which
      // wins over the static toolPolicy default. OpenClaw exposes plugin-specific
      // config as `api.pluginConfig` (and per-call as `event.context.pluginConfig`);
      // `api.config` / `event.config` are accepted as fallbacks for other hosts.
      const baseToolPolicy = options.toolPolicy ?? {};
      const pluginConfig = api?.pluginConfig ?? api?.config ?? {};
      const pluginConfigTimeout = normalizeNumber(pluginConfig.approvalTimeoutMs, undefined);

      // The `before_tool_call` approval gate is the always-on core and needs no
      // special hook permission. The three additional layers — run context
      // (`before_prompt_build`), runtime coverage (`before_agent_run`), and finalize
      // reflection (`before_agent_finalize`) — are OPT-IN (default off), because each
      // shapes or audits the turn rather than merely gating a tool, and each needs an
      // operator-granted hook permission (allowPromptInjection / allowConversationAccess).
      // A deliberately-off plugin must not claim those permissioned hooks for a no-op.
      //
      // Reflection value precedence (reviewRoles, maxAttempts, per-turn enable/disable):
      // per-call (event.context.pluginConfig) > plugin-level (api.pluginConfig) > static
      // options.reflection > built-in defaults — resolved per-call in the handler below.
      // Whether the finalize hook is REGISTERED at all is a startup decision from the
      // static/plugin `enabled` flag (default off) or a wired audit loader: a per-call
      // override can disable or tune reflection on a registered hook, but cannot register
      // it when reflection is globally disabled.
      const baseReflection = { ...(options.reflection ?? {}), ...(pluginConfig.reflection ?? {}) };
      const reflectionEnabled = normalizeBoolean(baseReflection.enabled, false);
      const baseRunContext = { ...(options.runContext ?? {}), ...(pluginConfig.runContext ?? {}) };
      const runContextEnabled = normalizeBoolean(baseRunContext.enabled, false);
      const baseRuntimeCoverage = { ...(options.runtimeCoverage ?? {}), ...(pluginConfig.runtimeCoverage ?? {}) };
      const runtimeCoverageEnforced = normalizeBoolean(baseRuntimeCoverage.enforce, false);

      if (runContextEnabled) {
        api.on(
          "before_prompt_build",
          async (event) => {
            const contextOptions = { ...baseRunContext, ...(callPluginConfig(event).runContext ?? {}) };
            return beforePromptBuildDecision(event, contextOptions);
          },
          { priority: options.contextPriority ?? 85, timeoutMs: options.contextTimeoutMs ?? 5_000 },
        );
      }

      if (runtimeCoverageEnforced) {
        api.on(
          "before_agent_run",
          async (event, ctx) => {
            const coverageOptions = { ...baseRuntimeCoverage, ...(callPluginConfig(event).runtimeCoverage ?? {}) };
            return beforeAgentRunDecision(event, ctx, coverageOptions);
          },
          { priority: options.runPriority ?? 90, timeoutMs: options.runTimeoutMs ?? 5_000 },
        );
      }

      api.on(
        "before_tool_call",
        async (event) => {
          const callConfig = callPluginConfig(event);
          const callConfigTimeout = normalizeNumber(callConfig.approvalTimeoutMs, undefined);
          const timeoutMs = [callConfigTimeout, pluginConfigTimeout, baseToolPolicy.timeoutMs].find((value) =>
            Number.isFinite(value),
          );
          const toolPolicy = Number.isFinite(timeoutMs) ? { ...baseToolPolicy, timeoutMs } : baseToolPolicy;
          return beforeToolCallDecision(event, toolPolicy);
        },
        { priority: options.toolPriority ?? 75, timeoutMs: options.toolTimeoutMs ?? 5_000 },
      );

      // Register the finalize gate when an external audit is wired OR built-in
      // reflection is enabled (the default). The handler composes them: a real audit
      // revise outranks reflection, and the two use distinct idempotency keys so the
      // host never double-revises.
      if (typeof options.loadCompletionAudit === "function" || reflectionEnabled) {
        api.on(
          "before_agent_finalize",
          async (event) => {
            if (typeof options.loadCompletionAudit === "function") {
              const audit = await options.loadCompletionAudit(event);
              const auditDecision = finalizeDecisionFromAudit(audit, options.finalizePolicy);
              if (auditDecision) {
                return auditDecision;
              }
            }
            const reflectionOptions = { ...baseReflection, ...(callPluginConfig(event).reflection ?? {}) };
            return reflectiveFinalizeDecision(event, reflectionOptions);
          },
          { priority: options.finalizePriority ?? 50, timeoutMs: options.finalizeTimeoutMs ?? 5_000 },
        );
      }
    },
  });
}
