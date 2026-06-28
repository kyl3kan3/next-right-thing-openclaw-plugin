import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createNextRightThingPlugin } from "./next-right-thing-hooks.mjs";

// The Next Right Thing plugin. The `before_tool_call` approval gate is the always-on
// core and needs no special hook permission. The three additional layers — run context
// (before_prompt_build), runtime coverage (before_agent_run), and finalize reflection
// (before_agent_finalize) — are opt-in (default off); each shapes or audits the turn and
// needs an operator-granted hook permission (allowPromptInjection / allowConversationAccess).
//
// The plugin's built-in configSchema (approvalTimeoutMs, reflection, runContext,
// runtimeCoverage) is used as-is, so it stays the single source of truth for config
// shape and defaults rather than being duplicated here.
export default createNextRightThingPlugin(definePluginEntry, {
  pluginId: "next-right-thing",
  name: "Next Right Thing",
  description:
    "Adds the Next Right Thing approval gate (always on), with opt-in run context, runtime coverage, and finalize reflection.",
  toolPolicy: {
    timeoutMs: 60_000,
    timeoutBehavior: "deny",
  },
});
