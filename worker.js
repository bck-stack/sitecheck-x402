// Cloudflare Worker entry. Config comes from wrangler.toml [vars].
import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { buildRoutes, SERVICE, ABOUT } from "./lib/routes.js";
import { audit, contacts, hiring } from "./lib/tools.js";
import * as ai from "./lib/ai.js";

// Workers can't await a promise started by another request (it hangs), and the x402
// middleware initializes lazily with a shared promise. So each request builds its own
// middleware until one has finished initializing; that one is then reused.
let cached, ready;
function build(env) {
  const network = env.NETWORK || "eip155:8453";
  const routes = buildRoutes(env.PAY_TO, network);
  return { routes, network };
}
function setup(env) {
  return (cached ??= build(env));
}
async function pay(c, next) {
  if (ready) return ready(c, next);
  const { routes, network } = setup(c.env);
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: c.env.FACILITATOR_URL || "https://facilitator.payai.network" }))
    .register(network, new ExactEvmScheme());
  const m = paymentMiddleware(routes, server);
  const res = await m(c, next);
  ready ??= m;
  return res;
}

const app = new Hono();
const origin = (c) => new URL(c.req.url).origin;
const endpoints = (c) => Object.entries(setup(c.env).routes).map(([k, r]) => ({ route: k, url: origin(c) + k.split(" ")[1], price: r.accepts.price, description: r.description }));

app.get("/", (c) => {
  const eps = endpoints(c);
  if ((c.req.header("accept") || "").includes("text/html")) {
    const rows = eps.map((e) => `<tr><td><code>${e.route}</code></td><td>${e.price}</td><td>${e.description}</td></tr>`).join("");
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SiteCheck API</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 16px;color:#111}td{border-top:1px solid #ddd;padding:8px;vertical-align:top}code{background:#f3f3f3;padding:2px 4px}</style></head><body><main><h1>SiteCheck API</h1><p>${ABOUT}</p><table>${rows}</table><p>Call any endpoint; you get HTTP 402 with payment requirements. Any x402 client (x402-fetch, x402-axios, Coinbase AgentKit) pays and retries automatically.</p><p>Example: <code>GET /api/audit?url=example.com</code></p></main></body></html>`);
  }
  return c.json({ name: SERVICE, about: ABOUT, endpoints: eps });
});
app.get("/health", (c) => c.json({ ok: true }));
app.get("/.well-known/x402", (c) => {
  const eps = endpoints(c);
  return c.json({ version: 1, x402Version: 2, name: SERVICE, description: ABOUT, resources: eps.map((e) => e.url), endpoints: eps.map((e) => ({ url: e.url, method: e.route.split(" ")[0], price: e.price, description: e.description })) });
});
app.get("/openapi.json", (c) => {
  const { routes, network } = setup(c.env);
  return c.json({
    openapi: "3.1.0",
    info: { title: "SiteCheck API", version: "1.0.0", description: ABOUT },
    servers: [{ url: origin(c) }],
    paths: Object.fromEntries(Object.entries(routes).map(([k, r]) => {
      const [method, path] = k.split(" ");
      const info = r.extensions.bazaar.info.input;
      const op = {
        summary: r.description, tags: r.tags,
        "x-payment-info": { protocols: ["x402"], price: r.accepts.price, network, asset: "USDC" },
        responses: { 200: { description: "JSON result" }, 402: { description: "Payment required (x402)" } },
      };
      if (method === "GET") {
        const params = info.queryParams || {};
        op.parameters = Object.keys(params).map((name) => ({ name, in: "query", required: name === "url", schema: { type: "string" }, example: params[name] }));
      } else {
        op.requestBody = { required: true, content: { "application/json": { example: info.body } } };
      }
      return [path, { [method.toLowerCase()]: op }];
    })),
  });
});

app.use("/api/*", (c, next) => c.req.method === "HEAD" ? c.body(null, 405) : c.env.PAY_TO ? pay(c, next) : c.json({ error: "PAY_TO not configured" }, 503));

const wrap = (fn) => async (c) => {
  try { return c.json(await fn(c.req.query())); }
  catch (e) { return c.json({ error: e.message }, 400); }
};
app.get("/api/audit", wrap((q) => audit(q.url)));
app.get("/api/contacts", wrap((q) => contacts(q.url)));
app.get("/api/hiring", wrap((q) => hiring(q)));

const aiWrap = (fn) => async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: "JSON body required" }, 400); }
  try { return c.json(await fn(c.env.AI, body || {})); }
  catch (e) { return c.json({ error: e.status === 400 ? e.message : "model temporarily unavailable, you were not charged" }, e.status === 400 ? 400 : 503); }
};
for (const name of ["image", "transcribe", "tts", "embed", "chat"]) app.post(`/api/${name}`, aiWrap(ai[name]));

// Owner-only smoke test (no payment): /selftest?key=SELFTEST_KEY&t=image
app.get("/selftest", async (c) => {
  if (!c.env.SELFTEST_KEY || c.req.query("key") !== c.env.SELFTEST_KEY) return c.notFound();
  const t = c.req.query("t");
  const samples = { image: { prompt: "a lighthouse at dawn", steps: 2 }, tts: { text: "Test." }, embed: { text: "hello" }, chat: { prompt: "Say OK.", max_tokens: 5 }, transcribe: { url: c.req.query("u") } };
  try { const r = await ai[t](c.env.AI, samples[t]); return c.json({ ok: true, keys: Object.keys(r), preview: JSON.stringify(r).slice(0, 300) }); }
  catch (e) { return c.json({ ok: false, error: String(e.message || e) }, 500); }
});

export default app;
