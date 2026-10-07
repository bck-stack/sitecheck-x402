// Helpers for the business and compliance tool tests. No live network: fetch is replaced by a router.
import { createApp, fullEnv, json } from "./helpers.js";

const SECRET = "rapid-secret";
export const env = (extra = {}) => fullEnv({ RAPIDAPI_PROXY_SECRET: SECRET, ...extra });

// Calls a route like a RapidAPI subscriber (the proxy secret skips x402), so the real handler and its status codes run.
export const callTool = (path, extra = {}) => createApp().request(path, { headers: { "x-rapidapi-proxy-secret": SECRET } }, env(extra));

// Replaces globalThis.fetch. `routes` is a list of [matcher, answer]; answer is a Response, a body (-> 200 JSON) or a function(call).
// Returns the recorded calls. An unmatched URL throws, so a test can't touch the network by accident.
export function mockFetch(t, routes) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const call = { url, method: init.method || "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body && JSON.parse(init.body), signal: init.signal };
    calls.push(call);
    for (const [match, answer] of routes) {
      if (typeof match === "string" ? !url.includes(match) : !match.test(url)) continue;
      const out = typeof answer === "function" ? await answer(call) : answer;
      if (out instanceof Error) throw out;
      return out instanceof Response ? out : json(out);
    }
    throw new Error(`unexpected network call in test: ${url}`);
  };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}
export const status = (code, body = {}) => json(body, code);
export { json };
