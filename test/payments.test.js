// npm test. No network: both facilitators are played by a fake fetch (see helpers.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG } from "../lib/routes.js";
import { paymentNetworks } from "../lib/networks.js";
import { PAYAI_URL, CIRCLE_URL } from "../lib/networks.js";
import {
  BASE, ARC, SOLANA, ARC_USDC, ADDR, FEE_PAYER, fullEnv, mockFacilitators, createApp, request,
  decodePaymentRequired, evmPaymentHeader, solanaPaymentHeader,
} from "./helpers.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const atomic = (price) => String(Math.round(Number(price.slice(1)) * 1e6));

// Sends the unpaid request for a catalog route ("GET /api/audit" etc.).
function call(app, route, env, headers = {}) {
  const [method, path] = route.split(" ");
  if (method === "GET") return request(app, `${path}?url=example.com`, env, { headers });
  return request(app, path, env, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ text: "hi", prompt: "hi" }) });
}

test("every route answers 402 with one accepts entry per configured network", async (t) => {
  mockFacilitators(t);
  const app = createApp();
  const env = fullEnv();
  for (const [route, tool] of Object.entries(CATALOG)) {
    const res = await call(app, route, env);
    assert.equal(res.status, 402, route);
    const { accepts, resource } = decodePaymentRequired(res);
    assert.deepEqual(accepts.map((a) => a.network), [BASE, SOLANA, ARC], route);
    for (const a of accepts) {
      assert.equal(a.scheme, "exact");
      assert.equal(a.amount, atomic(tool.price), `${route} on ${a.network}`);
    }
    const [base, solana, arc] = accepts;
    assert.deepEqual([base.payTo, base.asset, base.extra.name, base.extra.version], [ADDR.base, USDC_BASE, "USD Coin", "2"]);
    assert.deepEqual([solana.payTo, solana.asset, solana.extra.feePayer], [ADDR.solana, USDC_SOLANA, FEE_PAYER]);
    assert.deepEqual([arc.payTo, arc.asset, arc.extra.name, arc.extra.version], [ADDR.arc, ARC_USDC, "USDC", "2"]);
    assert.equal(resource.description, tool.description);
  }
});

test("an empty PAY_TO variable hides that network", async (t) => {
  mockFacilitators(t);
  const cases = [
    [{ PAY_TO_SOLANA: "", PAY_TO_ARC: "" }, [BASE]],
    [{ PAY_TO: "", PAY_TO_ARC: "" }, [SOLANA]],
    [{ PAY_TO: "", PAY_TO_SOLANA: "" }, [ARC]],
    [{ PAY_TO_SOLANA: "" }, [BASE, ARC]],
    [{ PAY_TO: " " }, [SOLANA, ARC]],
  ];
  for (const [overrides, expected] of cases) {
    const env = fullEnv(overrides);
    const res = await call(createApp(), "GET /api/audit", env);
    assert.equal(res.status, 402);
    assert.deepEqual(decodePaymentRequired(res).accepts.map((a) => a.network), expected, JSON.stringify(overrides));
    const wellKnown = await (await request(createApp(), "/.well-known/x402", env)).json();
    assert.deepEqual(wellKnown.networks.map((n) => n.network), expected);
  }
});

test("Arc stays hidden without CIRCLE_API_KEY; invalid addresses are skipped", async (t) => {
  mockFacilitators(t);
  const env = fullEnv({ CIRCLE_API_KEY: "", PAY_TO_SOLANA: "0x1111111111111111111111111111111111111111" });
  const res = await call(createApp(), "GET /api/audit", env);
  assert.deepEqual(decodePaymentRequired(res).accepts.map((a) => a.network), [BASE]);
  const health = await (await request(createApp(), "/health", env)).json();
  assert.deepEqual(health.networks, ["base"]);
  assert.deepEqual(health.skipped.map((s) => s.key).sort(), ["arc", "solana"]);
  assert.match(health.skipped.find((s) => s.key === "arc").reason, /CIRCLE_API_KEY/);
});

test("no configured network means 503, not a 402 nobody can pay", async (t) => {
  const fx = mockFacilitators(t);
  const res = await call(createApp(), "GET /api/audit", { PAY_TO: "", PAY_TO_SOLANA: "", PAY_TO_ARC: "" });
  assert.equal(res.status, 503);
  assert.equal(fx.calls.length, 0);
});

test("a failed handler never settles, on any network", async (t) => {
  const fx = mockFacilitators(t);
  const app = createApp();
  const env = fullEnv({ AI: { run: async () => { throw new Error("model down"); } } });
  const unpaid = decodePaymentRequired(await call(app, "POST /api/embed", env));
  const payments = {
    [BASE]: await evmPaymentHeader(unpaid, BASE),
    [ARC]: await evmPaymentHeader(unpaid, ARC),
    [SOLANA]: solanaPaymentHeader(unpaid),
  };
  for (const [network, header] of Object.entries(payments)) {
    const res = await call(app, "POST /api/embed", env, header);
    assert.equal(res.status, 503, network);
    assert.match((await res.json()).error, /not charged/);
  }
  assert.equal(fx.verifies().length, 3, "each payment is verified before the handler runs");
  assert.equal(fx.settles().length, 0, "nothing is settled");

  // A handler that rejects the input (400) doesn't settle either.
  const audit = decodePaymentRequired(await request(app, "/api/audit?url=localhost", env));
  const res = await request(app, "/api/audit?url=localhost", env, { headers: await evmPaymentHeader(audit, BASE) });
  assert.equal(res.status, 400);
  assert.equal(fx.settles().length, 0);
});

test("a successful call settles once, through the facilitator for its network", async (t) => {
  const fx = mockFacilitators(t);
  const app = createApp();
  const env = fullEnv();
  const unpaid = decodePaymentRequired(await call(app, "POST /api/embed", env));
  const expected = { [BASE]: PAYAI_URL, [SOLANA]: PAYAI_URL, [ARC]: CIRCLE_URL };
  for (const network of [BASE, SOLANA, ARC]) {
    const header = network === SOLANA ? solanaPaymentHeader(unpaid) : await evmPaymentHeader(unpaid, network);
    const res = await call(app, "POST /api/embed", env, header);
    assert.equal(res.status, 200, network);
    const receipt = JSON.parse(Buffer.from(res.headers.get("payment-response"), "base64").toString());
    assert.equal(receipt.transaction, "0xsettled");
    assert.equal(receipt.network, network);
    const settle = fx.settles().at(-1);
    assert.equal(settle.url, `${expected[network]}/settle`);
    assert.equal(settle.body.paymentRequirements.network, network);
    assert.equal(settle.headers.authorization, network === ARC ? "Bearer test-circle-key" : undefined);
  }
  assert.equal(fx.settles().length, 3);
  // The Circle key is never sent to PayAI, and /supported is fetched without it.
  for (const c of fx.calls) if (!c.url.startsWith(CIRCLE_URL) || c.url.endsWith("/supported")) assert.equal(c.headers.authorization, undefined, c.url);
});

test("a failed settlement returns 402 and no result", async (t) => {
  mockFacilitators(t, { settle: (body) => ({ success: false, errorReason: "settlement_pending", transaction: "", network: body.paymentRequirements.network, payer: "" }) });
  const app = createApp();
  const env = fullEnv();
  const unpaid = decodePaymentRequired(await call(app, "POST /api/embed", env));
  const res = await call(app, "POST /api/embed", env, await evmPaymentHeader(unpaid, ARC));
  assert.equal(res.status, 402);
  assert.equal((await res.text()).includes("embeddings"), false);
});

test("discovery documents list every configured network", async (t) => {
  mockFacilitators(t);
  const app = createApp();
  const env = fullEnv();
  const wellKnown = await (await request(app, "/.well-known/x402", env)).json();
  assert.equal(wellKnown.version, 1);
  assert.equal(wellKnown.resources.length, Object.keys(CATALOG).length);
  assert.deepEqual(wellKnown.networks.map((n) => [n.key, n.network, n.payTo]), [["base", BASE, ADDR.base], ["solana", SOLANA, ADDR.solana], ["arc", ARC, ADDR.arc]]);
  assert.equal(wellKnown.endpoints.find((e) => e.url.endsWith("/api/audit")).amount, "20000");

  const openapi = await (await request(app, "/openapi.json", env)).json();
  const info = openapi.paths["/api/audit"].get["x-payment-info"];
  assert.deepEqual(info.price, { mode: "fixed", currency: "USD", amount: "0.02" });
  assert.deepEqual(info.protocols[0].x402.networks.map((n) => [n.network, n.asset, n.amount]), [[BASE, USDC_BASE, "20000"], [SOLANA, USDC_SOLANA, "20000"], [ARC, ARC_USDC, "20000"]]);

  const html = await (await request(app, "/", env, { headers: { accept: "text/html" } })).text();
  for (const name of ["Base", "Solana", "Arc", BASE, SOLANA, ARC, "/api/audit", "$0.02"]) assert.ok(html.includes(name), name);
});

test("paymentNetworks trims values and reports why a network is off", () => {
  const { active, skipped } = paymentNetworks({ PAY_TO: `  ${ADDR.base} `, PAY_TO_ARC: "not-an-address", CIRCLE_API_KEY: "k" });
  assert.deepEqual(active.map((n) => [n.key, n.payTo]), [["base", ADDR.base]]);
  assert.deepEqual(skipped, [
    { key: "solana", reason: "PAY_TO_SOLANA is empty" },
    { key: "arc", reason: "PAY_TO_ARC is not a valid Arc address" },
  ]);
});

test("RapidAPI proxy secret skips x402 only on the audit and contacts routes", async (t) => {
  mockFacilitators(t);
  const app = createApp();
  const env = fullEnv({ RAPIDAPI_PROXY_SECRET: "rapid-secret-123" });
  const ok = { "x-rapidapi-proxy-secret": "rapid-secret-123" };
  for (const route of ["GET /api/audit", "GET /api/contacts"]) {
    assert.notEqual((await call(app, route, env, ok)).status, 402, route);
    assert.equal((await call(app, route, env, { "x-rapidapi-proxy-secret": "wrong-secret-12" })).status, 402, route);
    assert.equal((await call(app, route, fullEnv(), ok)).status, 402, `${route} without a configured secret`);
  }
  assert.equal((await call(app, "POST /api/embed", env, ok)).status, 402);
});

test("CDP keys move Base and Solana to the Coinbase facilitator; Arc stays on Circle", async () => {
  const { paymentNetworks } = await import("../lib/networks.js");
  const off = paymentNetworks(fullEnv()).active;
  assert.ok(off.filter((n) => n.key !== "arc").every((n) => n.facilitator === "payai"));
  const on = paymentNetworks(fullEnv({ CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "secret" })).active;
  assert.deepEqual(on.map((n) => [n.key, n.facilitator]), off.map((n) => [n.key, n.key === "arc" ? n.facilitator : "cdp"]));
});
