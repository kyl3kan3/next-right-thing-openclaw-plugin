// Command trigger adapter — starts a gateway turn by running a CLI command.
//
// NOTE: the stock `openclaw` binary has NO command to submit a prompt, so the
// OpenClaw-native trigger is the HTTP webhook ingress (see the `http` adapter and
// heartbeat/README.md). This adapter is for hosts that DO expose such a CLI; its
// command array is install-specific — verify it before relying on it.

import { spawn } from "node:child_process";

/**
 * Build the argv + stdin for a tick. Pure, so it can be unit-tested.
 * - promptVia "stdin" (default): the prompt is piped to the command's stdin.
 * - promptVia "arg": the prompt is appended as the final argument.
 * @returns {{argv:string[], stdin:string|null}}
 */
export function buildCommand(prompt, trigger = {}) {
  const base = Array.isArray(trigger.command) ? [...trigger.command] : [];
  if (base.length === 0) {
    throw new Error("command trigger requires a non-empty `command` array in config");
  }
  if (trigger.promptVia === "arg") {
    return { argv: [...base, prompt], stdin: null };
  }
  return { argv: base, stdin: prompt };
}

export async function dispatch(prompt, trigger = {}) {
  const { argv, stdin } = buildCommand(prompt, trigger);
  const [cmd, ...rest] = argv;
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, rest, { stdio: [stdin == null ? "ignore" : "pipe", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)),
    );
    if (stdin != null) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}
