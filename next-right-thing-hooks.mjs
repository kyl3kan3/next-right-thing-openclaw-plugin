const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;
const MAX_APPROVAL_DESCRIPTION_LENGTH = 256;

export const HARD_EFFECTS = new Set([
  "spend_money",
  "publish",
  "send_message",
  "contact_people",
  "delete_data",
  "overwrite_data",
  "rotate_credentials",
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

const PRODUCTION_PATTERNS = [
  /\bvercel\b.*(?:^|\s)--prod\b/i,
  /\bwrangler\b.*\bdeploy\b/i,
  /\bkubectl\b.*\b(apply|delete|rollout|scale)\b/i,
  /\bflyctl\b.*\bdeploy\b/i,
  /\brailway\b.*\b(up|deploy)\b/i,
  /\bterraform\b.*\b(apply|destroy)\b/i,
];

const DESTRUCTIVE_PATTERNS = [
  /\brm\b(?=.*(?:\s-[a-z]*r|\s--recursive))(?=.*(?:\s-[a-z]*f|\s--force))/i,
  /\bRemove-Item\b.*\s-Recurse\b/i,
  /\bgit\b.*\breset\b.*\s--hard\b/i,
  /\bgit\b.*\bclean\b.*(?:\s-[a-z]*f|\s--force\b)/i,
  /\bgit\b.*\bpush\b.*(?:\s-[a-z]*f|\s--force(?:-with-lease)?\b|\s\+\S)/i,
  /\bcurl\b.*(?:\s-X\s*DELETE|\s--request[=\s]\s*DELETE)\b/i,
];

// SQL destructive statements are tool-agnostic: dedicated database tools (e.g. MCP
// execute_sql / query tools) carry them in params rather than a shell command, so
// these are scanned for every tool call, not only exec/shell runners.
const SQL_DESTRUCTIVE_PATTERNS = [
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\s+(?:TABLE\s+)?\w/i,
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
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/i,
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

function commandText(event) {
  const params = event?.params ?? {};
  return String(params.cmd ?? params.command ?? params.input ?? params.script ?? stringifyParams(params));
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
  const toolName = String(event?.toolName ?? "");
  const toolKind = String(event?.toolKind ?? event?.ctx?.toolKind ?? "");
  const text = commandText(event);
  const allParamsText = stringifyParams(event?.params);
  const effects = new Set();

  // Scan the whole params object, not just the command string, so a secret in
  // headers/body/env alongside an innocuous command is still treated as exposure.
  if (anyPattern(SECRET_PATTERNS, text) || anyPattern(SECRET_PATTERNS, allParamsText)) {
    effects.add("security_exposure");
  }

  const toolNameTokens = toolName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
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
  // would false-fire on, e.g., a web search about "DELETE FROM".
  if (looksLikeExec || looksLikeDatabase) {
    if (anyPattern(SQL_DESTRUCTIVE_PATTERNS, text) || anyPattern(SQL_DESTRUCTIVE_PATTERNS, allParamsText)) {
      effects.add("delete_data");
    }
  }

  if (looksLikeExec) {
    // Scan the serialized params too, not just the command string: object-valued
    // input/script payloads collapse to "[object Object]" in commandText and would
    // otherwise hide the real command. Also scan a punctuation-normalized copy so
    // structured argv (e.g. {cmd:"rm",args:["-rf","x"]}) reads as a spaced command
    // string, since the destructive regexes expect whitespace before flags.
    const spacedParams = allParamsText.replace(/[{}[\],:"]/g, " ");
    const execText = `${text}\n${allParamsText}\n${spacedParams}`;
    if (anyPattern(PRODUCTION_PATTERNS, execText)) {
      effects.add("mutate_production");
    }
    if (anyPattern(DESTRUCTIVE_PATTERNS, execText)) {
      effects.add("delete_data");
    }
    if (anyPattern(PUBLISH_PATTERNS, execText)) {
      effects.add("publish");
    }
  }

  if (toolName.includes("email") || toolName.includes("gmail") || toolName.includes("outlook")) {
    effects.add("send_message");
  }
  if (toolName.includes("slack") || toolName.includes("discord") || toolName.includes("telegram")) {
    effects.add("send_message");
  }
  if (toolName.includes("billing") || toolName.includes("stripe")) {
    effects.add("financial_exposure");
  }
  if (toolName.includes("deploy")) {
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
  const highSeverity = effects.some((effect) => effect === "delete_data" || effect === "mutate_production");
  const risk = highSeverity ? 5 : effects.length > 0 ? 4 : 1;
  const irreversibility = highSeverity ? 4 : 1;
  const approvalRequired = effects.some((effect) => HARD_EFFECTS.has(effect));
  const candidate = {
    id: overrides.id ?? `${event?.toolCallId ?? event?.runId ?? event?.toolName ?? "tool"}-candidate`,
    title: overrides.title ?? `Run tool: ${String(event?.toolName ?? "unknown")}`,
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
 * Create the OpenClaw plugin entry, registering the `before_tool_call` approval
 * gate and (when `loadCompletionAudit` is supplied) the `before_agent_finalize`
 * completion-audit gate.
 *
 * @param {Function} definePluginEntry - The OpenClaw `definePluginEntry` factory.
 * @param {object} [options] - Plugin metadata, tool/finalize policy, and audit loader.
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
      "Adds Next Right Thing approval gates and completion-audit review hooks.",
    configSchema:
      options.configSchema ?? {
        type: "object",
        additionalProperties: false,
        properties: {
          approvalTimeoutMs: { type: "integer", minimum: 0 },
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

      api.on(
        "before_tool_call",
        async (event) => {
          const callConfig = event?.context?.pluginConfig ?? event?.config ?? {};
          const callConfigTimeout = normalizeNumber(callConfig.approvalTimeoutMs, undefined);
          const timeoutMs = [callConfigTimeout, pluginConfigTimeout, baseToolPolicy.timeoutMs].find((value) =>
            Number.isFinite(value),
          );
          const toolPolicy = Number.isFinite(timeoutMs) ? { ...baseToolPolicy, timeoutMs } : baseToolPolicy;
          return beforeToolCallDecision(event, toolPolicy);
        },
        { priority: options.toolPriority ?? 75, timeoutMs: options.toolTimeoutMs ?? 5_000 },
      );

      if (typeof options.loadCompletionAudit === "function") {
        api.on(
          "before_agent_finalize",
          async (event) => {
            const audit = await options.loadCompletionAudit(event);
            return finalizeDecisionFromAudit(audit, options.finalizePolicy);
          },
          { priority: options.finalizePriority ?? 50, timeoutMs: options.finalizeTimeoutMs ?? 5_000 },
        );
      }
    },
  });
}
