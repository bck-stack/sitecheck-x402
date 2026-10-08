import { test } from "node:test";
import assert from "node:assert/strict";
import { fullEnv, mockFacilitators, createApp, evmPaymentHeader, BASE } from "./helpers.js";
import { toolName } from "../lib/mcp.js";

const rpc = (app, env, body) => app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }, env);

test("initialize, notifications and tools/list", async (t) => {
  mockFacilitators(t);
  const app = createApp(), env = fullEnv();
  const init = await (await rpc(app, env, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json();
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "sitecheck");
  assert.match(init.result.instructions, /x402\/payment/);
  assert.equal((await rpc(app, env, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = await (await rpc(app, env, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  const names = list.result.tools.map((x) => x.name);
  for (const n of ["read", "email_check", "solana_token", "uk_insolvency", "pdf", "translate"]) assert.ok(names.includes(n), n);
  const iban = list.result.tools.find((x) => x.name === "iban");
  assert.match(iban.description, /Price: \$0\.001 in USDC/);
  assert.equal(iban.inputSchema.type, "object");
  assert.equal((await app.request("/mcp", {}, env)).status, 405);
  const unknown = await (await rpc(app, env, { jsonrpc: "2.0", id: 3, method: "nope" })).json();
  assert.equal(unknown.error.code, -32601);
  assert.equal(toolName("GET /api/solana/token"), "solana_token");
});

test("tools/call without payment returns the x402 PaymentRequired; with a signed payload it runs and settles", async (t) => {
  const fx = mockFacilitators(t);
  const app = createApp(), env = fullEnv();
  const unpaid = await (await rpc(app, env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "iban", arguments: { iban: "DE89 3704 0044 0532 0130 00" } } })).json();
  assert.equal(unpaid.result.isError, true);
  const pr = unpaid.result.structuredContent;
  assert.equal(pr.x402Version, 2);
  assert.ok(pr.accepts.some((a) => a.network === BASE && a.amount === "1000"));
  assert.deepEqual(JSON.parse(unpaid.result.content[0].text), pr);
  const header = await evmPaymentHeader(pr, BASE);
  const payload = JSON.parse(Buffer.from(header["PAYMENT-SIGNATURE"], "base64").toString("utf8"));
  const paid = await (await rpc(app, env, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "iban", arguments: { iban: "DE89 3704 0044 0532 0130 00" }, _meta: { "x402/payment": payload } } })).json();
  assert.equal(paid.result.isError, undefined);
  assert.equal(paid.result.structuredContent.valid, true);
  assert.ok(paid.result._meta["x402/payment-response"].success);
  assert.equal(fx.settles().length, 1);
});

test("a paid call whose tool fails is an MCP error and is not settled", async (t) => {
  const fx = mockFacilitators(t);
  const app = createApp(), env = fullEnv();
  const pr = (await (await rpc(app, env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "iban", arguments: {} } })).json()).result.structuredContent;
  const payload = JSON.parse(Buffer.from((await evmPaymentHeader(pr, BASE))["PAYMENT-SIGNATURE"], "base64").toString("utf8"));
  const r = await (await rpc(app, env, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "iban", arguments: {}, _meta: { "x402/payment": payload } } })).json();
  assert.equal(r.result.isError, true);
  assert.equal(r.result.structuredContent.charged, false);
  assert.equal(fx.settles().length, 0);
});
