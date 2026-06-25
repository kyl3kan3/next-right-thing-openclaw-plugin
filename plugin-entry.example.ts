import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createNextRightThingPlugin } from "./next-right-thing-hooks.mjs";

export default createNextRightThingPlugin(definePluginEntry, {
  pluginId: "next-right-thing",
  description: "Adds Next Right Thing approval gates and completion-audit review hooks.",
  toolPolicy: {
    timeoutMs: 60_000,
    timeoutBehavior: "deny",
  },
  // Built-in reflective deliberation runs by default (no runtime needed). Tune or
  // disable it here; extra review lenses are merged with the defaults (critic/verifier).
  reflection: {
    enabled: true,
    reviewRoles: ["security"], // merged with the built-in critic/verifier defaults
    maxAttempts: 1,
  },
  loadCompletionAudit: async () => {
    // Replace with a call to runtime/nrt_supervisor.py audit --state <session-state>.
    // Return the parsed audit JSON. When status !== "complete", the adapter asks
    // OpenClaw for one more model pass before the final answer is accepted.
    return undefined;
  },
});
