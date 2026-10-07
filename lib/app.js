// The SiteCheck app. worker.js exports createApp(); tests build fresh instances with their own env.
import { Hono } from "hono";
import { convertToTokenAmount } from "@x402/core/utils";
import { paymentNetworks } from "./networks.js";
import { buildRoutes, about, catalogFor, SERVICE } from "./routes.js";
import { createPaymentMiddleware, facilitators } from "./payments.js";
import { TRIAL_EXHAUSTED } from "./circle.js";
import { landingPage } from "./landing.js";
import { audit, contacts, hiring } from "./tools.js";
import { pantaConfig, pantaClient, ttlCache } from "./panta.js";
import * as markets from "./markets.js";
import * as ai from "./ai.js";
import { vat } from "./vat.js";
import { iban } from "./iban.js";
import { lei } from "./lei.js";
import { recalls } from "./recalls.js";
import { violations } from "./violations.js";
import { ukInsolvency } from "./ukInsolvency.js";

const REPO = "https://github.com/bck-stack/sitecheck-x402";
const FACILITATOR_NAMES = { payai: "PayAI", cdp: "Coinbase CDP", circle: "Circle Facilitator Service" };
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f5eff"/><path d="M9 16.5l4.5 4.5L23 11.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const usd = (price) => price.replace(/^\$/, "");
// Unpaid /api routes. The report only forwards a signature to Panta for attribution.
const FREE = new Set(["POST /api/markets/report"]);
const REPORT_OP = {
  summary: "Free. After your wallet signed and broadcast a transaction from POST /api/markets/build-buy, send its signature here so Panta confirms and attributes the trade. Powered by Panta.",
  tags: ["prediction markets", "panta"],
  security: [], // free: tells x402 discovery tools (x402scan) not to probe it for a 402
  requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { signature: { type: "string" }, wallet: { type: "string" }, id: { type: "string", description: "Panta market id" }, orderId: { type: "string" }, quoteId: { type: "string" } }, required: ["signature", "wallet", "id"] } } } },
  responses: { 200: { description: "Attribution stored" }, 202: { description: "Not confirmed on chain yet: report again in a few seconds" } },
};
// Routes also sold through RapidAPI (no Workers AI or Panta calls behind them).
const RAPIDAPI_ROUTES = new Set(["GET /api/audit", "GET /api/contacts", "GET /api/vat", "GET /api/iban", "GET /api/lei", "GET /api/recalls", "GET /api/violations", "GET /api/uk-insolvency"]);
const sameSecret = (given, expected) => {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
};
// JSON Schema inferred from a route's documented example, so callers see the response fields and types.
// Whole numbers become "integer" (counts, scores, dimensions) except for continuous measures such as
// timestamps, durations, prices and probabilities, where an example of 0 or 1 must not forbid 3.2.
const CONTINUOUS = /^(start|end|duration|seconds?|time|.*(price|prob|probability|odds|amount|usd|usdc|volume|impact|avg|average|ratio|rate))$/i;
const schemaOf = (v, key = "") => {
  if (Array.isArray(v)) return { type: "array", items: v.length ? schemaOf(v[0], key) : {} };
  if (v === null) return { type: "null" };
  if (typeof v === "object") return { type: "object", properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, schemaOf(x, k)])) };
  if (typeof v === "number") return { type: Number.isInteger(v) && !CONTINUOUS.test(key) ? "integer" : "number" };
  return { type: typeof v };
};
const atomic = (price) => convertToTokenAmount(usd(price), 6); // USDC uses 6 decimals on all three networks

export function createApp() {
  // Workers can't await a promise started by another request (it hangs), and the x402 middleware
  // initializes lazily with a shared promise. So each request builds and initializes its own
  // middleware until one has finished initializing; that one is then reused.
  let cached, ready;
  // What Circle has told this instance about Arc (set by lib/circle.js), for /health.
  const arcState = { trialExhaustedAt: null };
  // The prediction-market tools exist only when PANTA_API_KEY is set; their cache lives as long as this instance.
  const setup = (env) => {
    if (!cached) {
      const { active, skipped } = paymentNetworks(env);
      const panta = pantaConfig(env);
      const catalog = catalogFor({ markets: panta.enabled });
      cached = {
        networks: active, skipped, catalog, routes: buildRoutes(active, catalog), panta,
        markets: panta.enabled ? { panta: pantaClient(panta), cache: ttlCache() } : null,
      };
    }
    return cached;
  };
  async function pay(c, next) {
    if (ready) return ready(c, next);
    const { networks, routes } = setup(c.env);
    let m;
    try { m = await createPaymentMiddleware(c.env, networks, routes, facilitators(c.env, networks, arcState)); }
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
  const endpoints = (c) => Object.entries(setup(c.env).catalog).map(([route, t]) => {
    const [method, path] = route.split(" ");
    return { route, method, url: origin(c) + path, price: t.price, description: t.description };
  });
  const networkInfo = (n) => ({ key: n.key, name: n.name, network: n.network, asset: n.asset, symbol: "USDC", decimals: 6, payTo: n.payTo, facilitator: FACILITATOR_NAMES[n.facilitator] });

  const aboutFor = (c) => { const { networks, markets: m } = setup(c.env); return about(networks, { markets: Boolean(m) }); };
  const isMarket = (e) => new URL(e.url).pathname.startsWith("/api/markets");

  app.get("/", (c) => {
    const { networks } = setup(c.env);
    const eps = endpoints(c);
    if ((c.req.header("accept") || "").includes("text/html")) {
      return c.html(landingPage({ origin: origin(c), about: aboutFor(c), endpoints: eps.filter((e) => !isMarket(e)), marketEndpoints: eps.filter(isMarket), networks: networks.map(networkInfo), repo: REPO }));
    }
    return c.json({ name: SERVICE, about: aboutFor(c), networks: networks.map(networkInfo), endpoints: eps.map(({ route, url, price, description }) => ({ route, url, price, description })) });
  });

  // `arc.trialExhausted` reflects what this Worker instance has seen since it started;
  // the log line "[arc] Circle's keyless trial allowance ..." is the durable record.
  app.get("/health", (c) => {
    const { networks, skipped, panta } = setup(c.env);
    const body = { ok: true, networks: networks.map((n) => n.key), skipped };
    body.markets = panta.enabled ? { enabled: true, provider: "Panta", baseUrl: panta.baseUrl } : { enabled: false, provider: "Panta", reason: panta.reason };
    const arc = networks.find((n) => n.key === "arc");
    if (arc) {
      body.arc = { auth: arc.auth, payTo: arc.payTo };
      if (arc.auth === "seller-proof") {
        body.arc.trialExhausted = Boolean(arcState.trialExhaustedAt);
        if (arcState.trialExhaustedAt) Object.assign(body.arc, { trialExhaustedAt: arcState.trialExhaustedAt, warning: TRIAL_EXHAUSTED });
      }
    }
    return c.json(body);
  });

  // Proof of control for the agent-tools.cloud directory listing (https://agent-tools.cloud/docs/claim). Not a secret.
  app.get("/.well-known/agent-tools-verify.txt", (c) => c.text("atc_MHA_VrY3-67SVKkZaEOa444j6A_2RG4w\n"));
  // Plain-text summary for LLMs and agent directories (llms.txt convention).
  app.get("/llms.txt", (c) => {
    const lines = [
      `# ${SERVICE}`, "", `> ${aboutFor(c)}`, "",
      "Pay per call with x402 v2 (USDC). Call any /api/* route without payment to get the 402 challenge, then repeat it with a PAYMENT-SIGNATURE header. A payment settles only when the call succeeds.", "",
      "## Endpoints",
      ...endpoints(c).map((e) => `- [${e.method} ${new URL(e.url).pathname}](${e.url}) (${e.price}): ${e.description}`),
      "", "## Machine-readable",
      `- [OpenAPI](${origin(c)}/openapi.json)`, `- [x402 discovery](${origin(c)}/.well-known/x402)`, `- [Source code](${REPO})`, "",
    ];
    return c.text(lines.join("\n"), 200, { "content-type": "text/plain; charset=utf-8" });
  });

  const discovery = (c) => {
    const { networks } = setup(c.env);
    const eps = endpoints(c);
    return c.json({
      version: 1, x402Version: 2, name: SERVICE, description: aboutFor(c),
      resources: eps.map((e) => e.url),
      networks: networks.map(networkInfo),
      endpoints: eps.map((e) => ({ url: e.url, method: e.method, price: e.price, amount: atomic(e.price), description: e.description, networks: networks.map((n) => n.network) })),
    });
  };
  app.get("/.well-known/x402", discovery);
  app.get("/.well-known/x402.json", discovery);

  app.get("/openapi.json", (c) => {
    const { networks, routes, catalog, markets: m } = setup(c.env);
    const names = networks.map((n) => n.name).join(", ") || "none configured";
    return c.json({
      openapi: "3.1.0",
      info: {
        title: "SiteCheck API", version: "1.2.0", description: aboutFor(c), contact: { url: REPO, email: "hello@offerastudio.com" },
        "x-guidance": `Call any /api/* operation without payment first. The 402 answer's PAYMENT-REQUIRED header (base64 JSON, x402 v2) lists one "exact" USDC option per network (${names}). Sign one with an x402 client and repeat the request with the PAYMENT-SIGNATURE header. Payment settles only when the call succeeds.`,
      },
      servers: [{ url: origin(c) }],
      externalDocs: { url: REPO },
      paths: Object.fromEntries([...Object.entries(routes).map(([k, r]) => {
        const [method, path] = k.split(" ");
        const t = catalog[k];
        const info = r.extensions.bazaar.info.input;
        const schema = { type: "object", ...t.inputSchema };
        const op = {
          summary: t.description, tags: t.tags,
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: usd(t.price) },
            protocols: [{ x402: { version: 2, scheme: "exact", networks: networks.map((n) => ({ network: n.network, name: n.name, asset: n.asset, symbol: "USDC", amount: atomic(t.price), payTo: n.payTo })) } }],
          },
          responses: { 200: { description: "Successful result (shape shown by the schema and example)", content: { "application/json": { schema: schemaOf(t.example), example: t.example } } }, 402: { description: "Payment required (x402). The PAYMENT-REQUIRED header lists one option per network." } },
        };
        if (method === "GET") {
          op.parameters = Object.entries(schema.properties).map(([name, s]) => ({ name, in: "query", required: (schema.required || []).includes(name), schema: { type: "string" }, description: s.description, example: info.queryParams?.[name] }));
        } else {
          op.requestBody = { required: true, content: { "application/json": { schema, example: info.body } } };
        }
        return [path, { [method.toLowerCase()]: op }];
      }), ...(m ? [["/api/markets/report", { post: REPORT_OP }]] : [])]),
    });
  });

  app.get("/favicon.svg", (c) => c.body(FAVICON, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }));
  app.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 301));

  app.use("/api/*", (c, next) => {
    if (c.req.method === "HEAD") return c.body(null, 405);
    if (FREE.has(`${c.req.method} ${c.req.path}`)) return next();
    // RapidAPI bills its own subscribers and proves each forwarded request with the proxy secret.
    if (RAPIDAPI_ROUTES.has(`${c.req.method} ${c.req.path}`) && sameSecret(c.req.header("x-rapidapi-proxy-secret"), c.env.RAPIDAPI_PROXY_SECRET)) return next();
    return setup(c.env).networks.length ? pay(c, next) : c.json({ error: "no payment network configured (set PAY_TO, PAY_TO_SOLANA, or ARC_SELLER_KEY / PAY_TO_ARC)" }, 503);
  });

  // Handlers return 4xx/5xx on failure; the x402 middleware only settles responses below 400,
  // so a buyer is never charged for a failed call.
  // Errors that carry an HTTP status (lib/upstream.js ToolError: 400 bad input, 404 not found, 502/503 upstream down) keep it;
  // anything else is a 400, as before. `fn` also receives the Worker env, for the optional secrets.
  const wrap = (fn) => async (c) => {
    try { return c.json(await fn(c.req.query(), c.env)); }
    catch (e) {
      const status = e.status >= 400 && e.status < 600 ? e.status : 400;
      if (status >= 500) console.error(`${c.req.path} failed:`, e.message);
      return c.json({ error: e.message, ...e.body }, status);
    }
  };
  app.get("/api/audit", wrap((q) => audit(q.url)));
  app.get("/api/contacts", wrap((q) => contacts(q.url)));
  app.get("/api/hiring", wrap((q) => hiring(q)));
  // Business and compliance data (lib/vat.js ... lib/ukInsolvency.js)
  app.get("/api/vat", wrap(vat));
  app.get("/api/iban", wrap(iban));
  app.get("/api/lei", wrap(lei));
  app.get("/api/recalls", wrap(recalls));
  app.get("/api/violations", wrap(violations));
  app.get("/api/uk-insolvency", wrap(ukInsolvency));

  const aiWrap = (fn) => async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: "JSON body required" }, 400); }
    try { return c.json(await fn(c.env.AI, body || {})); }
    catch (e) { return c.json({ error: e.status === 400 ? e.message : "model temporarily unavailable, you were not charged" }, e.status === 400 ? 400 : 503); }
  };
  for (const name of ["image", "transcribe", "tts", "embed", "chat"]) app.post(`/api/${name}`, aiWrap(ai[name]));

  // Prediction markets (Panta). Errors map to 4xx/5xx, so a failed Panta call is never settled, and
  // every answer, errors included, carries the disclaimer and the "Powered by Panta" attribution.
  const marketWrap = (fn, { json = false } = {}) => async (c) => {
    const { markets: ctx } = setup(c.env);
    if (!ctx) return c.json({ error: "prediction-market tools are not enabled on this deployment", ...markets.FOOTER }, 404);
    let input = c.req.query();
    if (json) {
      try { input = await c.req.json(); } catch { return c.json({ error: "JSON body required", ...markets.FOOTER }, 400); }
      if (!input || typeof input !== "object" || Array.isArray(input)) return c.json({ error: "JSON object body required", ...markets.FOOTER }, 400);
    }
    try {
      const out = await fn({ ...ctx, AI: c.env.AI }, input);
      return c.json(out, out.attribution === "pending" ? 202 : 200);
    } catch (e) {
      const [status, body] = markets.errorResponse(e);
      if (body.retryAfterSec) c.header("Retry-After", String(body.retryAfterSec));
      return c.json(body, status);
    }
  };
  app.get("/api/markets", marketWrap(markets.search));
  app.get("/api/markets/brief", marketWrap(markets.brief));
  app.post("/api/markets/quote", marketWrap(markets.quote, { json: true }));
  app.post("/api/markets/build-buy", marketWrap(markets.buildBuy, { json: true }));
  app.post("/api/markets/report", marketWrap(markets.report, { json: true })); // free: see FREE

  // Owner-only smoke test (no payment): /selftest?key=SELFTEST_KEY&t=image
  app.get("/selftest", async (c) => {
    if (!c.env.SELFTEST_KEY || c.req.query("key") !== c.env.SELFTEST_KEY) return c.notFound();
    const t = c.req.query("t");
    const business = { vat: [vat, { number: "DE811907980" }], iban: [iban, { iban: "DE89 3704 0044 0532 0130 00" }], lei: [lei, { q: "529900T8BM49AURSDO55" }], recalls: [recalls, { limit: "3" }], violations: [violations, { company: "Chevron Phillips", state: "TX", limit: "3" }], "uk-insolvency": [ukInsolvency, { limit: "3" }] };
    if (business[t]) {
      try { const r = await business[t][0]({ ...business[t][1], ...(c.req.query("q") ? { q: c.req.query("q") } : {}) }, c.env); return c.json({ ok: true, keys: Object.keys(r), preview: JSON.stringify(r).slice(0, 600) }); }
      catch (e) { return c.json({ ok: false, status: e.status, error: String(e.message || e) }, 500); }
    }
    const samples = { image: { prompt: "a lighthouse at dawn", steps: 2 }, tts: { text: "Test." }, embed: { text: "hello" }, chat: { prompt: "Say OK.", max_tokens: 5 }, transcribe: { url: c.req.query("u") } };
    try { const r = await ai[t](c.env.AI, samples[t]); return c.json({ ok: true, keys: Object.keys(r), preview: JSON.stringify(r).slice(0, 300) }); }
    catch (e) { return c.json({ ok: false, error: String(e.message || e) }, 500); }
  });

  return app;
}
