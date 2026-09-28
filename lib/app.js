// The SiteCheck app. worker.js exports createApp(); tests build fresh instances with their own env.
import { Hono } from "hono";
import { convertToTokenAmount } from "@x402/core/utils";
import { paymentNetworks } from "./networks.js";
import { buildRoutes, about, CATALOG, SERVICE } from "./routes.js";
import { createPaymentMiddleware } from "./payments.js";
import { landingPage } from "./landing.js";
import { audit, contacts, hiring } from "./tools.js";
import * as ai from "./ai.js";

const REPO = "https://github.com/bck-stack/sitecheck-x402";
const FACILITATOR_NAMES = { payai: "PayAI", circle: "Circle Facilitator Service" };
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f5eff"/><path d="M9 16.5l4.5 4.5L23 11.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const usd = (price) => price.replace(/^\$/, "");
const atomic = (price) => convertToTokenAmount(usd(price), 6); // USDC uses 6 decimals on all three networks

export function createApp() {
  // Workers can't await a promise started by another request (it hangs), and the x402 middleware
  // initializes lazily with a shared promise. So each request builds and initializes its own
  // middleware until one has finished initializing; that one is then reused.
  let cached, ready;
  const setup = (env) => {
    if (!cached) {
      const { active, skipped } = paymentNetworks(env);
      cached = { networks: active, skipped, routes: buildRoutes(active) };
    }
    return cached;
  };
  async function pay(c, next) {
    if (ready) return ready(c, next);
    const { networks, routes } = setup(c.env);
    let m;
    try { m = await createPaymentMiddleware(c.env, networks, routes); }
    catch (e) {
      console.error("x402 init failed:", e?.message || e);
      return c.json({ error: "payment facilitator unavailable, please retry" }, 503);
    }
    const res = await m(c, next);
    ready ??= m;
    return res;
  }

  const app = new Hono();
  const origin = (c) => new URL(c.req.url).origin;
  const endpoints = (c) => Object.entries(CATALOG).map(([route, t]) => {
    const [method, path] = route.split(" ");
    return { route, method, url: origin(c) + path, price: t.price, description: t.description };
  });
  const networkInfo = (n) => ({ key: n.key, name: n.name, network: n.network, asset: n.asset, symbol: "USDC", decimals: 6, payTo: n.payTo, facilitator: FACILITATOR_NAMES[n.facilitator] });

  app.get("/", (c) => {
    const { networks } = setup(c.env);
    if ((c.req.header("accept") || "").includes("text/html")) {
      return c.html(landingPage({ origin: origin(c), about: about(networks), endpoints: endpoints(c), networks: networks.map(networkInfo), repo: REPO }));
    }
    return c.json({ name: SERVICE, about: about(networks), networks: networks.map(networkInfo), endpoints: endpoints(c).map(({ route, url, price, description }) => ({ route, url, price, description })) });
  });

  app.get("/health", (c) => {
    const { networks, skipped } = setup(c.env);
    return c.json({ ok: true, networks: networks.map((n) => n.key), skipped });
  });

  app.get("/.well-known/x402", (c) => {
    const { networks } = setup(c.env);
    const eps = endpoints(c);
    return c.json({
      version: 1, x402Version: 2, name: SERVICE, description: about(networks),
      resources: eps.map((e) => e.url),
      networks: networks.map(networkInfo),
      endpoints: eps.map((e) => ({ url: e.url, method: e.method, price: e.price, amount: atomic(e.price), description: e.description, networks: networks.map((n) => n.network) })),
    });
  });

  app.get("/openapi.json", (c) => {
    const { networks, routes } = setup(c.env);
    const names = networks.map((n) => n.name).join(", ") || "none configured";
    return c.json({
      openapi: "3.1.0",
      info: {
        title: "SiteCheck API", version: "1.1.0", description: about(networks), contact: { url: REPO },
        "x-guidance": `Call any /api/* operation without payment first. The 402 answer's PAYMENT-REQUIRED header (base64 JSON, x402 v2) lists one "exact" USDC option per network (${names}). Sign one with an x402 client and repeat the request with the PAYMENT-SIGNATURE header. Payment settles only when the call succeeds.`,
      },
      servers: [{ url: origin(c) }],
      externalDocs: { url: REPO },
      paths: Object.fromEntries(Object.entries(routes).map(([k, r]) => {
        const [method, path] = k.split(" ");
        const t = CATALOG[k];
        const info = r.extensions.bazaar.info.input;
        const schema = { type: "object", ...t.inputSchema };
        const op = {
          summary: t.description, tags: t.tags,
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: usd(t.price) },
            protocols: [{ x402: { version: 2, scheme: "exact", networks: networks.map((n) => ({ network: n.network, name: n.name, asset: n.asset, symbol: "USDC", amount: atomic(t.price), payTo: n.payTo })) } }],
          },
          responses: { 200: { description: "JSON result" }, 402: { description: "Payment required (x402). The PAYMENT-REQUIRED header lists one option per network." } },
        };
        if (method === "GET") {
          op.parameters = Object.entries(schema.properties).map(([name, s]) => ({ name, in: "query", required: (schema.required || []).includes(name), schema: { type: "string" }, description: s.description, example: info.queryParams?.[name] }));
        } else {
          op.requestBody = { required: true, content: { "application/json": { schema, example: info.body } } };
        }
        return [path, { [method.toLowerCase()]: op }];
      })),
    });
  });

  app.get("/favicon.svg", (c) => c.body(FAVICON, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }));
  app.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 301));

  app.use("/api/*", (c, next) => {
    if (c.req.method === "HEAD") return c.body(null, 405);
    return setup(c.env).networks.length ? pay(c, next) : c.json({ error: "no payment network configured (set PAY_TO, PAY_TO_SOLANA or PAY_TO_ARC)" }, 503);
  });

  // Handlers return 4xx/5xx on failure; the x402 middleware only settles responses below 400,
  // so a buyer is never charged for a failed call.
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

  return app;
}
