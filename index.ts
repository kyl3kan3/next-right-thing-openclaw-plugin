import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createNextRightThingPlugin } from "./next-right-thing-hooks.mjs";

export default createNextRightThingPlugin(definePluginEntry, {
  pluginId: "next-right-thing",
  name: "Next Right Thing",
  description: "Adds Next Right Thing approval gates and completion-audit review hooks.",
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
            default: true,
            description: "Enable the built-in reflective deliberation on finalize (default true).",
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
    },
  },
  toolPolicy: {
    timeoutMs: 60_000,
    timeoutBehavior: "deny",
  },
});
