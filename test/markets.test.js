// Prediction-market tools (Panta). No network: Panta and the facilitators are played by a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getBase64Encoder, getTransactionDecoder, getCompiledTransactionMessageDecoder } from "@solana/kit";
import { MARKET_CATALOG, CATALOG } from "../lib/routes.js";
import { PANTA_URL, DISCLAIMER, pantaClient, ttlCache } from "../lib/panta.js";
import * as markets from "../lib/markets.js";
import { signedBy } from "../lib/unsignedTx.js";
import { BASE, ARC, SOLANA, ADDR, fullEnv, createApp, request, decodePaymentRequired, evmPaymentHeader, solanaPaymentHeader, json } from "./helpers.js";
import { PANTA_KEY, WALLET, IDS, SIGNATURE, BLOCKHASH, PROGRAM, mockPanta, pantaEnv, chatAI, NEUTRAL, buildAnswer } from "./panta-mock.js";

const atomic = (price) => String(Math.round(Number(price.slice(1)) * 1e6));
const ORDER = { id: IDS.btc, side: "yes", amountUsdc: "5.00", wallet: WALLET };
const INPUT = {
  "GET /api/markets": { query: "?q=bitcoin&limit=5" },
  "GET /api/markets/brief": { query: `?id=${IDS.btc}` },
  "POST /api/markets/quote": { body: ORDER },
  "POST /api/markets/build-buy": { body: ORDER },
};

function send(app, env, route, { query = "", body, headers = {} } = {}) {
  const [method, path] = route.split(" ");
  if (method === "GET") return request(app, path + query, env, { headers });
  return request(app, path, env, { method, headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

// Unpaid request -> 402 -> the same request paid on `network`.
async function paid(app, env, route, input = INPUT[route], network = BASE) {
  const unpaid = decodePaymentRequired(await send(app, env, route, input));
  const header = network === SOLANA ? solanaPaymentHeader(unpaid) : await evmPaymentHeader(unpaid, network);
  return send(app, env, route, { ...input, headers: header });
}

const footer = (body, where) => {
  assert.equal(body.disclaimer, DISCLAIMER, `${where}: disclaimer`);
  assert.deepEqual(body.poweredBy, { text: "Powered by Panta", url: "https://panta.market" }, `${where}: attribution`);
};

// The tools called directly, with the real client against the fake Panta.
const direct = (AI = chatAI(NEUTRAL)) => ({ panta: pantaClient({ baseUrl: PANTA_URL, key: PANTA_KEY }), cache: ttlCache(), AI });

test("each market route answers 402 with one accepts entry per configured network", async (t) => {
  const fx = mockPanta(t);
  const app = createApp();
  const env = pantaEnv();
  for (const [route, tool] of Object.entries(MARKET_CATALOG)) {
    const res = await send(app, env, route, INPUT[route]);
    assert.equal(res.status, 402, route);
    const { accepts, resource } = decodePaymentRequired(res);
    assert.deepEqual(accepts.map((a) => a.network), [BASE, SOLANA, ARC], route);
    assert.deepEqual(accepts.map((a) => a.payTo), [ADDR.base, ADDR.solana, ADDR.arc], route);
    for (const a of accepts) assert.equal(a.amount, atomic(tool.price), `${route} on ${a.network}`);
    assert.equal(resource.description, tool.description);
  }
  assert.deepEqual(Object.values(MARKET_CATALOG).map((t) => t.price), ["$0.002", "$0.01", "$0.005", "$0.01"]);
  assert.equal(fx.panta().length, 0, "Panta is not called before payment");
});

test("without PANTA_API_KEY the market routes are hidden, and /health says why", async (t) => {
  const fx = mockPanta(t);
  const off = fullEnv();
  const health = await (await request(createApp(), "/health", off)).json();
  assert.deepEqual(health.markets, { enabled: false, provider: "Panta", reason: "PANTA_API_KEY secret is not set" });

  const wellKnown = await (await request(createApp(), "/.well-known/x402", off)).json();
  assert.equal(wellKnown.endpoints.some((e) => e.url.includes("/api/markets")), false);
  assert.equal(wellKnown.resources.length, Object.keys(CATALOG).length);
  const openapi = await (await request(createApp(), "/openapi.json", off)).json();
  assert.equal(Object.keys(openapi.paths).some((p) => p.startsWith("/api/markets")), false);
  const html = await (await request(createApp(), "/", off, { headers: { accept: "text/html" } })).text();
  assert.equal(html.includes("Prediction markets (Panta)"), false);

  // Not offered for payment: no 402, no Panta call, nothing settled.
  for (const route of [...Object.keys(MARKET_CATALOG), "POST /api/markets/report"]) {
    const res = await send(createApp(), off, route, INPUT[route] || { body: { signature: SIGNATURE, wallet: WALLET, id: IDS.btc } });
    assert.equal(res.status, 404, route);
    footer(await res.json(), route);
  }
  assert.equal(fx.panta().length, 0);
  assert.equal(fx.settles().length, 0);

  for (const [url, reason] of [["http://panta.example/api/v1", /https/], ["not a url", /valid URL/]]) {
    const h = await (await request(createApp(), "/health", pantaEnv({ PANTA_BASE_URL: url }))).json();
    assert.equal(h.markets.enabled, false);
    assert.match(h.markets.reason, reason);
  }
});

test("with PANTA_API_KEY: discovery, OpenAPI and the landing page list the market tools; the key never shows", async (t) => {
  mockPanta(t);
  const app = createApp();
  const env = pantaEnv();
  const texts = [];
  const get = async (path, headers) => { const r = await request(app, path, env, { headers }); const s = await r.text(); texts.push(s); return s; };

  const health = JSON.parse(await get("/health"));
  assert.deepEqual(health.markets, { enabled: true, provider: "Panta", baseUrl: PANTA_URL });
  const wellKnown = JSON.parse(await get("/.well-known/x402"));
  const listed = wellKnown.endpoints.filter((e) => e.url.includes("/api/markets")).map((e) => [new URL(e.url).pathname, e.method, e.amount]);
  assert.deepEqual(listed, [["/api/markets", "GET", "2000"], ["/api/markets/brief", "GET", "10000"], ["/api/markets/quote", "POST", "5000"], ["/api/markets/build-buy", "POST", "10000"]]);
  assert.match(wellKnown.description, /powered by Panta/);

  const openapi = JSON.parse(await get("/openapi.json"));
  assert.deepEqual(openapi.paths["/api/markets/quote"].post["x-payment-info"].price, { mode: "fixed", currency: "USD", amount: "0.005" });
  assert.deepEqual(openapi.paths["/api/markets"].get.parameters.map((p) => p.name), ["q", "status", "category", "limit"]);
  assert.equal(openapi.paths["/api/markets/report"].post["x-payment-info"], undefined, "report is free");

  const html = await get("/", { accept: "text/html" });
  for (const s of ["Prediction markets (Panta)", '<a href="https://panta.market">Powered by Panta</a>', "/api/markets/build-buy", "$0.002", "never signs, holds keys or custodies funds", "not financial advice"]) {
    assert.ok(html.includes(s), s);
  }
  for (const s of texts) assert.equal(s.includes(PANTA_KEY), false, "the Panta key never appears");
});

test("a paid market call settles once; the key goes only to Panta, with trailing slashes", async (t) => {
  const fx = mockPanta(t);
  const app = createApp();
  const env = pantaEnv();
  for (const network of [BASE, SOLANA, ARC]) {
    const res = await paid(app, env, "GET /api/markets", INPUT["GET /api/markets"], network);
    assert.equal(res.status, 200, network);
    footer(await res.json(), network);
  }
  assert.equal(fx.settles().length, 3);
  for (const c of fx.calls) {
    const toPanta = c.url.startsWith(PANTA_URL);
    assert.equal(c.headers["x-api-key"], toPanta ? PANTA_KEY : undefined, c.url);
    assert.equal(c.url.includes(PANTA_KEY), false, "never in the URL");
    if (toPanta) assert.match(new URL(c.url).pathname, /\/$/, "Panta paths end with a slash");
  }
});

test("search: scans every catalog page, matches words, puts open markets first, reads live odds", async (t) => {
  const fx = mockPanta(t);
  const ctx = direct();
  const out = await markets.search(ctx, { q: "bitcoin" });
  assert.equal(out.scanned, 4, "both catalog pages were read");
  assert.equal(out.catalogComplete, true);
  assert.deepEqual(out.results.map((r) => r.id), [IDS.btc, IDS.etf], "the open market before the resolved one");
  const [btc, etf] = out.results;
  assert.equal(btc.question, "Will BTC close above $150k on 2026-12-31?");
  assert.deepEqual(btc.priceUsdc, { yes: 0.31, no: 0.69 });
  assert.deepEqual(btc.impliedProbability, { yes: 0.31, no: 0.69 });
  assert.equal(btc.volumeUsdc, 1200);
  assert.equal(btc.closesAt, "2026-12-31T23:59:59.000Z");
  assert.equal(btc.resolutionSource, "https://www.coingecko.com");
  assert.equal(btc.buyable, true);
  assert.equal(etf.buyable, false);
  assert.equal(etf.impliedProbability, null);

  // YES 0.52 + NO 0.50: the implied probability is normalized to sum to 1.
  const eth = (await markets.search(ctx, { q: "eth", category: "crypto" })).results[0];
  assert.deepEqual(eth.impliedProbability, { yes: 0.5098, no: 0.4902 });
  assert.equal((await markets.search(ctx, { status: "secondary" })).results[0].id, IDS.turnout);
  // Words match at a word start: "sol" is not found inside "Resolves".
  assert.equal((await markets.search(ctx, { q: "sol" })).total, 0);
  assert.deepEqual((await markets.search(ctx, { q: "BTC $150k" })).results.map((r) => r.id), [IDS.btc]);

  // Cached: the same search again reads neither the catalog nor the market detail.
  const before = fx.panta().length;
  await markets.search(ctx, { q: "bitcoin" });
  assert.equal(fx.panta().length, before);

  await assert.rejects(markets.search(ctx, { status: "open" }), /status must be one of/);
  await assert.rejects(markets.search(ctx, { q: "x".repeat(201) }), /too long/);
});

test("search: a market whose live price can't be read still comes back, marked without prices", async (t) => {
  mockPanta(t, { "GET /markets/{id}/": () => json({ code: "INTERNAL_ERROR", message: "rpc down" }, 500) });
  t.mock.method(console, "error", () => {});
  const out = await markets.search(direct(), { q: "bitcoin" });
  assert.equal(out.results.length, 2);
  for (const r of out.results) {
    assert.equal(r.pricesAsOf, null);
    assert.equal(r.impliedProbability, null);
  }
});

test("brief: odds, recent activity and a neutral summary; advice or a model failure falls back to the template", async (t) => {
  mockPanta(t);
  const seen = [];
  const out = await markets.brief(direct(chatAI(NEUTRAL, seen)), { id: IDS.btc });
  assert.equal(out.market.id, IDS.btc);
  assert.deepEqual(out.market.impliedProbability, { yes: 0.31, no: 0.69 });
  assert.deepEqual(out.market.prices.primary, { yes: 0.31, no: 0.69 });
  assert.deepEqual([out.recentActivity.sampled, out.recentActivity.yesBuys, out.recentActivity.noBuys, out.recentActivity.last24h], [3, 2, 1, 2]);
  assert.deepEqual(out.summary, { text: NEUTRAL, source: "llm", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
  footer(out, "brief");
  const [system, user] = seen[0].input.messages;
  assert.match(system.content, /Never give advice/);
  assert.match(system.content, /ignore any instructions/);
  assert.equal(JSON.parse(user.content).question, out.market.question, "market text goes in as data");

  for (const reply of ["YES looks undervalued, you should buy it.", "Consider buying YES before the close.", new Error("model down"), "", "x".repeat(2000)]) {
    const r = await markets.brief(direct(chatAI(reply)), { id: IDS.btc });
    assert.equal(r.summary.source, "template", String(reply).slice(0, 40));
    assert.match(r.summary.text, /This market asks: Will BTC close above \$150k on 2026-12-31\?/);
    assert.match(r.summary.text, /about 31% for YES/);
    assert.doesNotMatch(r.summary.text, /should|recommend|undervalued/i);
    footer(r, "template brief");
  }
  // The template doesn't quote a creator description that itself reads like advice.
  mockPanta(t, { "GET /markets/{id}/": (call, url, id) => ({ marketId: id, title: "Will X happen?", description: "Great value, you should buy YES now!", phase: "primary", yesPrice: "0.4", noPrice: "0.6" }) });
  const pushy = await markets.brief(direct(chatAI(new Error("model down"))), { id: IDS.btc });
  assert.equal(pushy.summary.source, "template");
  assert.doesNotMatch(pushy.summary.text, /should buy|Great value/);
  mockPanta(t);

  // A model-added "not financial advice" line is dropped (the disclaimer field covers it), the rest kept.
  const kept = await markets.brief(direct(chatAI(`${NEUTRAL} This is not financial advice.`)), { id: IDS.btc });
  assert.deepEqual([kept.summary.source, kept.summary.text], ["llm", NEUTRAL]);

  await assert.rejects(markets.brief(direct(), { id: "not-an-id" }), /id must be a Solana address/);
  await assert.rejects(markets.brief(direct(), { id: WALLET }), (e) => e.status === 404 && e.code === "MARKET_NOT_FOUND");
});

test("quote: Panta's expected fill plus price impact against the spot price", async (t) => {
  const fx = mockPanta(t);
  const out = await markets.quote(direct(), { ...ORDER, side: "YES", amountUsdc: 5 });
  assert.deepEqual(out.expectedFill, { shares: 15.8, avgPrice: 0.316456, feeUsdc: 0.1 });
  assert.equal(out.spotPrice, 0.31);
  assert.equal(out.priceImpact, 0.0208);
  assert.equal(out.quote.quoteId, "qt_test1");
  footer(out, "quote");
  const sent = fx.panta().find((c) => c.url.endsWith("/primaryorderquote/")).body;
  assert.deepEqual(sent, { wallet: WALLET, marketId: IDS.btc, side: "yes", amountUsdc: "5" });

  for (const [body, msg] of [
    [{ ...ORDER, side: "maybe" }, /side must be/], [{ ...ORDER, amountUsdc: "0" }, /amountUsdc/], [{ ...ORDER, amountUsdc: "-1" }, /amountUsdc/],
    [{ ...ORDER, amountUsdc: "1e3" }, /amountUsdc/], [{ ...ORDER, wallet: "0xabc" }, /wallet/], [{ ...ORDER, id: undefined }, /id must/],
  ]) await assert.rejects(markets.quote(direct(), body), msg);
});

test("build-buy never returns anything signed", async (t) => {
  // A misbehaving upstream: extra fields, including a signed transaction and a key, must not pass through.
  const fx = mockPanta(t, {
    "POST /primaryorderbuild/": (call) => ({ ...buildAnswer(call.body), transaction: "SIGNED-TX-FROM-UPSTREAM", signedTransaction: "AQID", secretKey: "leak" }),
  });
  const app = createApp();
  const env = pantaEnv();
  const res = await paid(app, env, "POST /api/markets/build-buy", { body: { ...ORDER, maxSlippageBps: 250 } });
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const s of ["SIGNED-TX-FROM-UPSTREAM", "signedTransaction", "secretKey", "leak"]) assert.equal(text.includes(s), false, s);
  const out = JSON.parse(text);
  footer(out, "build-buy");
  assert.equal(out.transaction.signed, false);
  assert.deepEqual(out.transaction.requiredSigners, [WALLET]);
  assert.equal(out.transaction.feePayer, WALLET);

  // The wire transaction has one empty signature slot, for the buyer's wallet, and Panta's instructions.
  assert.deepEqual(signedBy(out.transaction.data), []);
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(out.transaction.data));
  assert.deepEqual(Object.entries(tx.signatures), [[WALLET, null]]);
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(message.version, 0);
  assert.equal(message.lifetimeToken, BLOCKHASH);
  assert.equal(message.staticAccounts[0], WALLET, "the buyer pays the fee");
  assert.equal(message.instructions.length, 2);
  assert.equal(message.staticAccounts[message.instructions[0].programAddressIndex], PROGRAM);
  assert.deepEqual([...message.instructions[0].data], [1, 2, 3, 4], "instruction data is carried over byte for byte");
  assert.deepEqual(out.instructions, buildAnswer({ wallet: WALLET, quoteId: "qt_test1" }).instructions, "Panta's instructions, unchanged");

  assert.deepEqual(out.order.orderId, "ord_test1");
  assert.deepEqual(out.report.body, { signature: "<transaction signature>", orderId: "ord_test1", quoteId: "qt_test1", id: IDS.btc, wallet: WALLET });
  assert.match(out.custody, /never signs, holds keys or custodies funds/);
  const build = fx.panta().find((c) => c.url.endsWith("/primaryorderbuild/")).body;
  assert.deepEqual(build, { quoteId: "qt_test1", wallet: WALLET, maxSlippageBps: 250 });
  assert.equal(fx.settles().length, 1);
});

test("build-buy fails closed if Panta returns an order for another wallet or market, and nothing settles", async (t) => {
  t.mock.method(console, "error", () => {});
  const other = "So11111111111111111111111111111111111111112";
  for (const bad of [(b) => ({ ...buildAnswer(b), wallet: other }), (b) => buildAnswer(b, other), (b) => ({ ...buildAnswer(b), instructions: [] })]) {
    const fx = mockPanta(t, { "POST /primaryorderbuild/": bad });
    const res = await paid(createApp(), pantaEnv(), "POST /api/markets/build-buy");
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.error, /not charged/);
    footer(body, "fail closed");
    assert.equal(fx.settles().length, 0);
  }
});

test("a failed Panta call never settles, on any route or network", async (t) => {
  t.mock.method(console, "error", () => {});
  const failures = {
    "500": [() => json({ code: "INTERNAL_ERROR", message: "boom" }, 500), 502],
    "400": [() => json({ code: "AMOUNT_TOO_SMALL", message: "Amount below minimum fill", field: "amountUsdc" }, 400), 400],
    "404": [() => json({ code: "MARKET_NOT_FOUND", message: "Market account missing" }, 404), 404],
    "401": [() => json({ code: "UNAUTHORIZED", message: "authentication required" }, 401), 502],
    "429": [() => new Response(JSON.stringify({ code: "RATE_LIMITED", message: "slow down" }), { status: 429, headers: { "retry-after": "12", "content-type": "application/json" } }), 503],
    "html": [() => new Response("<html>bad gateway</html>", { status: 502 }), 502],
    "timeout": [() => { throw Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }); }, 504],
  };
  const everything = (fn) => Object.fromEntries(["GET /markets/", "GET /markets/{id}/", "GET /markets/{id}/trades/", "POST /primaryorderquote/", "POST /primaryorderbuild/"].map((k) => [k, fn]));
  for (const [name, [fail, status]] of Object.entries(failures)) {
    const fx = mockPanta(t, everything(fail));
    const app = createApp();
    const env = pantaEnv();
    for (const route of Object.keys(MARKET_CATALOG)) {
      for (const network of [BASE, SOLANA, ARC]) {
        const res = await paid(app, env, route, INPUT[route], network);
        assert.equal(res.status, status, `${name}: ${route} on ${network}`);
        const body = await res.json();
        assert.match(body.error, /not charged/, `${name}: ${route}`);
        footer(body, `${name}: ${route}`);
        if (name === "429") assert.equal(res.headers.get("retry-after"), "12");
        if (name === "400") assert.deepEqual([body.code, body.field], ["AMOUNT_TOO_SMALL", "amountUsdc"]);
      }
    }
    assert.ok(fx.verifies().length >= 12, "payments were verified before the handler ran");
    assert.equal(fx.settles().length, 0, `${name}: nothing settled`);
  }
});

test("the disclaimer is always present: success, bad input, upstream errors and the free report", async (t) => {
  t.mock.method(console, "error", () => {});
  const fx = mockPanta(t);
  const app = createApp();
  const env = pantaEnv();
  for (const route of Object.keys(MARKET_CATALOG)) {
    const ok = await paid(app, env, route);
    assert.equal(ok.status, 200, route);
    footer(await ok.json(), `${route} success`);
  }
  const badInput = {
    "GET /api/markets": { query: "?status=nope" },
    "GET /api/markets/brief": { query: "?id=" },
    "POST /api/markets/quote": { body: { ...ORDER, side: "up" } },
    "POST /api/markets/build-buy": { body: { ...ORDER, maxSlippageBps: 9999 } },
  };
  for (const [route, input] of Object.entries(badInput)) {
    const res = await paid(app, env, route, input);
    assert.equal(res.status, 400, route);
    footer(await res.json(), `${route} bad input`);
  }
  const notJson = await paid(app, env, "POST /api/markets/quote", { body: "{not json" });
  assert.equal(notJson.status, 400);
  footer(await notJson.json(), "not JSON");
  assert.equal(fx.settles().length, 4, "only the four successful calls settled");

  const report = await send(app, env, "POST /api/markets/report", { body: { signature: SIGNATURE, wallet: WALLET, id: IDS.btc } });
  footer(await report.json(), "report");
  const badReport = await send(app, env, "POST /api/markets/report", { body: { signature: "abc", wallet: WALLET, id: IDS.btc } });
  assert.equal(badReport.status, 400);
  footer(await badReport.json(), "bad report");
});

test("report is free and forwards the signature to Panta's submit and trade report", async (t) => {
  const fx = mockPanta(t);
  const app = createApp();
  const env = pantaEnv();
  const body = { signature: SIGNATURE, orderId: "ord_test1", quoteId: "qt_test1", id: IDS.btc, wallet: WALLET };
  const res = await send(app, env, "POST /api/markets/report", { body });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual([out.submitted, out.attribution, out.kind, out.side], ["submitted", "processed", "buy", "yes"]);
  const calls = fx.panta();
  assert.deepEqual(calls.find((c) => c.url.endsWith("/primaryordersubmit/")).body, { orderId: "ord_test1", signature: SIGNATURE, wallet: WALLET });
  assert.deepEqual(calls.find((c) => c.url.endsWith("/trades/")).body, { signature: SIGNATURE, wallet: WALLET, marketId: IDS.btc, quoteId: "qt_test1", clientOrderId: "ord_test1" });
  assert.equal(fx.verifies().length + fx.settles().length, 0, "no payment involved");

  // Works with no payment network at all, and without an orderId (trade report only).
  const noNetworks = pantaEnv({ PAY_TO: "", PAY_TO_SOLANA: "", PAY_TO_ARC: "" });
  const bare = await send(createApp(), noNetworks, "POST /api/markets/report", { body: { signature: SIGNATURE, wallet: WALLET, id: IDS.btc } });
  assert.equal(bare.status, 200);
  assert.equal((await bare.json()).submitted, null);
});

test("report: a signature Panta hasn't seen confirmed yet is 202 pending, not an error", async (t) => {
  mockPanta(t, { "POST /trades/": () => json({ code: "TX_NOT_FOUND", message: "Signature not observed" }, 404) });
  const res = await send(createApp(), pantaEnv(), "POST /api/markets/report", { body: { signature: SIGNATURE, wallet: WALLET, id: IDS.btc, orderId: "ord_test1" } });
  assert.equal(res.status, 202);
  const out = await res.json();
  assert.deepEqual([out.attribution, out.submitted, out.retryAfterSec], ["pending", "submitted", 10]);
  footer(out, "pending");
});
