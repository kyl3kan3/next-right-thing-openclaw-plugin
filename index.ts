import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createNextRightThingPlugin } from "./next-right-thing-hooks.mjs";

export default createNextRightThingPlugin(definePluginEntry, {
  pluginId: "next-right-thing",
  name: "Next Right Thing",
  description: "Adds Next Right Thing run context, approval gates, and completion-audit review hooks.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      approvalTimeoutMs: {
        type: "integer",
        minimum: 0,
        description: "Approval timeout in milliseconds for guarded tool calls.",
      },
      reflection: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: {
            type: "boolean",
            default: false,
            description:
              "Opt in to built-in reflective deliberation on finalize (default false; the no-runtime fallback for loadCompletionAudit). Requires hooks.allowConversationAccess.",
          },
          reviewRoles: {
            type: "array",
            items: {
              type: "string",
              enum: ["critic", "verifier", "security", "fact_checker", "memory_curator"],
            },
            description: "Extra review lenses to include in the contemplation.",
          },
          maxAttempts: {
            type: "integer",
            minimum: 1,
            default: 1,
            description: "How many times to ask the model to reflect before finalizing (default 1).",
          },
        },
      },
      runContext: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: {
            type: "boolean",
            default: false,
            description:
              "Opt in to injecting the Next Right Thing operating context into every model run via before_prompt_build (default false). Requires hooks.allowPromptInjection.",
          },
          instruction: {
            type: "string",
            description: "Optional replacement for the default Next Right Thing run-context instruction.",
          },
        },
      },
      runtimeCoverage: {
        type: "object",
        additionalProperties: false,
        properties: {
          enforce: {
            type: "boolean",
            default: false,
            description:
              "Opt in to the before_agent_run runtime-coverage preflight before model inference (default false; strict-coverage layer).",
          },
          allowUnidentifiedRuntime: {
            type: "boolean",
            default: true,
            description: "Allow models whose runtime/provider identity is not exposed to before_agent_run.",
          },
          blockedRuntimeIds: {
            type: "array",
            items: { type: "string" },
            description: "Optional runtime ids to block when strict tool coverage is required.",
          },
          blockedProviderIds: {
            type: "array",
            items: { type: "string" },
            description: "Optional provider ids to block when strict tool coverage is required.",
          },
          message: {
            type: "string",
            description: "Optional user-facing block message for uncovered runtime paths.",
          },
        },
      },
    },
  },
  toolPolicy: {
    timeoutMs: 60_000,
    timeoutBehavior: "deny",
  },
});
