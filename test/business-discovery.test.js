import { test } from "node:test";
import assert from "node:assert/strict";
import { fullEnv, mockFacilitators, createApp, request, decodePaymentRequired, evmPaymentHeader, BASE, json } from "./helpers.js";
import { CATALOG, about } from "../lib/routes.js";

const NEW = { "/api/vat": "0.002", "/api/iban": "0.001", "/api/lei": "0.005", "/api/recalls": "0.003", "/api/violations": "0.005", "/api/uk-insolvency": "0.003" };
const atomic = (usd) => String(Math.round(Number(usd) * 1e6));

test("the six business routes are in /openapi.json, /.well-known/x402, llms.txt and the catalog with the right prices", async (t) => {
  mockFacilitators(t);
  const app = createApp();
  const env = fullEnv();
  const openapi = await (await request(app, "/openapi.json", env)).json();
  const wk = await (await request(app, "/.well-known/x402", env)).json();
  const llms = await (await request(app, "/llms.txt", env)).text();
  for (const [path, price] of Object.entries(NEW)) {
    const op = openapi.paths[path]?.get;
    assert.ok(op, `${path} in openapi`);
    assert.equal(op["x-payment-info"].price.amount, price, path);
    assert.equal(op["x-payment-info"].protocols[0].x402.networks[0].amount, atomic(price), path);
    assert.ok(op.parameters.length > 0 && op.responses[200].content["application/json"].example, path);
    const ep = wk.endpoints.find((e) => e.url.endsWith(path));
    assert.ok(ep, `${path} in /.well-known/x402`);
    assert.deepEqual([ep.method, ep.price, ep.amount], ["GET", `$${price}`, atomic(price)]);
    assert.ok(wk.resources.some((r) => r.endsWith(path)));
    assert.ok(llms.includes(`(\$${price})`) && llms.includes(path), `${path} in llms.txt`);
    assert.equal(CATALOG[`GET ${path}`].price, `$${price}`);
  }
  assert.equal(Object.keys(openapi.paths).length, 25, "8 original + 6 business + 11 web/data/Solana/translation (Panta tools are off here)");
  assert.match(openapi.info.description, /VAT.*IBAN.*LEI.*recalls.*OSHA\/EPA.*UK insolvency/);
  assert.match(about([]), /business and compliance data/);
});

test("each route answers 402 with its price on every network when unpaid", async (t) => {
  mockFacilitators(t);
  const app = createApp();
  for (const [path, price] of Object.entries(NEW)) {
    const res = await request(app, `${path}?number=DE811907980&iban=x&q=x&company=x`, fullEnv());
    assert.equal(res.status, 402, path);
    const { accepts } = decodePaymentRequired(res);
    assert.equal(accepts.length, 3);
    for (const a of accepts) assert.equal(a.amount, atomic(price), path);
  }
});

test("a paid call that fails upstream is never settled; a successful one settles once", async (t) => {
  const fx = mockFacilitators(t, { handle: (call) => {
    if (call.url.includes("check-vat-number")) return json({ actionSucceed: false, errorWrappers: [{ error: "MS_UNAVAILABLE" }] });
  } });
  const app = createApp();
  const env = fullEnv();
  const unpaid = decodePaymentRequired(await request(app, "/api/vat?number=DE811907980", env));
  const header = await evmPaymentHeader(unpaid, BASE);
  const down = await request(app, "/api/vat?number=DE811907980", env, { headers: header });
  assert.equal(down.status, 503);
  assert.match((await down.json()).error, /not charged/);
  assert.equal(fx.settles().length, 0, "VIES down: nothing settled");
  // bad input: 400, nothing settled, no VIES call
  const bad = await request(app, "/api/vat?number=DE811907981", env, { headers: header });
  assert.equal(bad.status, 400);
  assert.equal(fx.settles().length, 0);
  // no network needed: IBAN succeeds and settles
  const iu = decodePaymentRequired(await request(app, "/api/iban?iban=DE89370400440532013000", env));
  const ok = await request(app, "/api/iban?iban=DE89370400440532013000", env, { headers: await evmPaymentHeader(iu, BASE) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).valid, true);
  assert.equal(fx.settles().length, 1);
});

test("/selftest runs a sample of each new tool (owner only)", async (t) => {
  mockFacilitators(t, { handle: (call) => {
    if (call.url.includes("check-vat-number")) return json({ valid: true, name: "X", address: "Y", requestDate: "2026-10-07T00:00:00Z" });
  } });
  const app = createApp();
  const env = fullEnv({ SELFTEST_KEY: "k" });
  assert.equal((await request(app, "/selftest?t=iban", env)).status, 404, "no key, no access");
  const iban = await (await request(app, "/selftest?key=k&t=iban", env)).json();
  assert.equal(iban.ok, true);
  const vat = await (await request(app, "/selftest?key=k&t=vat", env)).json();
  assert.equal(vat.ok, true);
  assert.match(vat.preview, /DE811907980/);
});
