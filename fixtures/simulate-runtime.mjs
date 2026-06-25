import { createNextRightThingPlugin } from "../next-right-thing-hooks.mjs";

const registered = [];
const definePluginEntry = (entry) => entry;
const plugin = createNextRightThingPlugin(definePluginEntry, {
  loadCompletionAudit: async () => ({
    status: "incomplete",
    requirements: [{ requirement: "production proof", status: "missing" }],
  }),
});

plugin.register({
  on(name, handler, opts) {
    registered.push({ name, handler, opts });
  },
});

const beforeToolCall = registered.find((item) => item.name === "before_tool_call");
const beforeFinalize = registered.find((item) => item.name === "before_agent_finalize");

const toolDecision = await beforeToolCall.handler({
  toolName: "exec",
  params: { cmd: "vercel deploy --prod" },
});
const finalizeDecision = await beforeFinalize.handler({});

console.log(
  JSON.stringify(
    {
      hooks: registered.map((item) => item.name),
      toolDecision,
      finalizeDecision,
    },
    null,
    2,
  ),
);
