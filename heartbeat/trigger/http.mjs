// HTTP trigger adapter — starts a gateway turn by POSTing the prompt.
//
// IMPORTANT: the gateway endpoint/body shape is install/version-specific. The
// example config uses PLACEHOLDER values; confirm the real endpoint and request
// shape for your gateway (see heartbeat/README.md) before relying on it.

/**
 * Build the fetch request for a tick. Pure, so it can be unit-tested.
 * `trigger.body` is an object template; the string "{{prompt}}" is replaced with
 * the prompt anywhere it appears (deeply). Defaults to { prompt }.
 * @returns {{url:string, init:{method:string, headers:object, body:string}}}
 */
export function buildRequest(prompt, trigger = {}) {
  if (!trigger.url) {
    throw new Error("http trigger requires a `url` in config");
  }
  const template = trigger.body ?? { prompt: "{{prompt}}" };
  const body = injectPrompt(template, prompt);
  return {
    url: trigger.url,
    init: {
      method: trigger.method ?? "POST",
      headers: { "content-type": "application/json", ...(trigger.headers ?? {}) },
      body: JSON.stringify(body),
    },
  };
}

/** Recursively replace the "{{prompt}}" sentinel in a JSON-able template. */
export function injectPrompt(value, prompt) {
  if (typeof value === "string") {
    return value.replaceAll("{{prompt}}", prompt);
  }
  if (Array.isArray(value)) {
    return value.map((v) => injectPrompt(v, prompt));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, injectPrompt(v, prompt)]));
  }
  return value;
}

export async function dispatch(prompt, trigger = {}) {
  const { url, init } = buildRequest(prompt, trigger);
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`gateway responded ${res.status} ${res.statusText}`);
  }
}
