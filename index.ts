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
        type: "number",
        description: "Approval timeout in milliseconds for guarded tool calls.",
      },
    },
  },
  toolPolicy: {
    timeoutMs: 60_000,
    timeoutBehavior: "deny",
  },
});
