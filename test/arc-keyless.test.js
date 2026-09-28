// Arc keyless trial: seller proofs instead of a Circle API key. No network: see helpers.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CIRCLE_URL } from "../lib/networks.js";
import { sellerProof } from "../lib/sellerProof.js";
import {
  BASE, ARC, ADDR, SELLER, SELLER_KEY, fullEnv, keylessEnv, mockFacilitators, createApp, request, json,
  decodePaymentRequired, evmPaymentHeader,
} from "./helpers.js";

// Written out from Circle's spec (sign-seller-proof), independently of lib/sellerProof.js.
const DOMAIN = { name: "Circle Facilitator Seller Request", version: "1", chainId: 5042 };
const TYPES = {
  SellerRequest: [
    { name: "purpose", type: "string" }, { name: "method", type: "string" }, { name: "bodyHash", type: "bytes32" },
    { name: "network", type: "string" }, { name: "payTo", type: "address" }, { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" },
  ],
};

const embed = (app, env, headers = {}) => request(app, "/api/embed", env, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ text: "hi" }) });
const circleCalls = (fx, path) => fx.calls.filter((c) => c.url === `${CIRCLE_URL}/${path}`);

function envelope(call) {
  const header = call.headers["facilitator-seller-proof"];
  assert.match(header, /^[A-Za-z0-9_-]+$/, "base64url without padding");
  return JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
}

// Rebuilds the SellerRequest the way Circle does (route, method, raw body, envelope) and recovers the signer.
function signerOf(env, { purpose, method = "POST", body }) {
  const message = {
    purpose, method, bodyHash: keccak256(body), network: env.network, payTo: env.payTo, nonce: env.nonce,
    issuedAt: BigInt(env.issuedAt), expiresAt: BigInt(env.expiresAt),
  };
  return recoverTypedDataAddress({ domain: DOMAIN, types: TYPES, primaryType: "SellerRequest", message, signature: env.signature });
}

async function payOnArc(t, env, options) {
  const fx = mockFacilitators(t, options);
  const app = createApp();
  const unpaid = decodePaymentRequired(await embed(app, env));
  const res = await embed(app, env, await evmPaymentHeader(unpaid, ARC));
  return { fx, app, unpaid, res };
}

test("keyless Arc: payTo is the seller key's address, and each proof recovers to it", async (t) => {
  const { fx, unpaid, res } = await payOnArc(t, keylessEnv());
  assert.equal(unpaid.accepts.find((a) => a.network === ARC).payTo, SELLER);
  assert.equal(res.status, 200);

  const calls = [...circleCalls(fx, "verify"), ...circleCalls(fx, "settle")];
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const env = envelope(call);
    assert.equal(env.version, 1);
    assert.equal(call.headers.authorization, undefined, "never both a proof and an API key");
    // network and payTo in the proof are exactly the ones in the body's paymentRequirements
    assert.equal(env.network, call.body.paymentRequirements.network);
    assert.equal(env.payTo, call.body.paymentRequirements.payTo);
    assert.equal(env.payTo, SELLER);
    assert.match(env.nonce, /^0x[0-9a-f]{64}$/);
    assert.ok(env.expiresAt > env.issuedAt && env.expiresAt - env.issuedAt <= 300, "valid for at most 5 minutes");
    assert.ok(Math.abs(env.issuedAt - Date.now() / 1000) < 30);
    const purpose = call.url.endsWith("/verify") ? "verify" : "settle";
    assert.equal(await signerOf(env, { purpose, body: call.raw }), SELLER, purpose);
  }
  assert.notEqual(envelope(calls[0]).nonce, envelope(calls[1]).nonce, "verify and settle use their own nonces");
});

test("keyless Arc: bodyHash covers the exact bytes that were sent", async (t) => {
  const { fx } = await payOnArc(t, keylessEnv());
  for (const call of [...circleCalls(fx, "verify"), ...circleCalls(fx, "settle")]) {
    const env = envelope(call);
    const purpose = call.url.endsWith("/verify") ? "verify" : "settle";
    assert.equal(await signerOf(env, { purpose, body: call.raw }), SELLER);
    // The same JSON, serialized differently, no longer matches the signature.
    const reformatted = new TextEncoder().encode(JSON.stringify(call.body, null, 1));
    assert.notEqual(await signerOf(env, { purpose, body: reformatted }), SELLER);
    const tampered = new TextEncoder().encode(new TextDecoder().decode(call.raw).replace(/"amount":"\d+"/, '"amount":"1"'));
    assert.notEqual(await signerOf(env, { purpose, body: tampered }), SELLER);
  }
});

test("keyless Arc: purpose is \"verify\" on /verify and \"settle\" on /settle", async (t) => {
  const { fx } = await payOnArc(t, keylessEnv());
  const [verify] = circleCalls(fx, "verify");
  const [settle] = circleCalls(fx, "settle");
  assert.equal(await signerOf(envelope(verify), { purpose: "verify", body: verify.raw }), SELLER);
  assert.notEqual(await signerOf(envelope(verify), { purpose: "settle", body: verify.raw }), SELLER);
  assert.equal(await signerOf(envelope(settle), { purpose: "settle", body: settle.raw }), SELLER);
  assert.notEqual(await signerOf(envelope(settle), { purpose: "verify", body: settle.raw }), SELLER);
  assert.notEqual(await signerOf(envelope(settle), { purpose: "settle", method: "GET", body: settle.raw }), SELLER);
});

test("a status proof (GET) hashes the empty body", async () => {
  const account = privateKeyToAccount(SELLER_KEY);
  const header = await sellerProof(account, { purpose: "status", method: "get", network: ARC, payTo: SELLER });
  const env = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  assert.equal(await signerOf(env, { purpose: "status", method: "GET", body: new Uint8Array() }), SELLER);
});

test("the seller key wins over CIRCLE_API_KEY", async (t) => {
  const env = keylessEnv({ CIRCLE_API_KEY: "test-circle-key", PAY_TO_ARC: SELLER.toLowerCase() });
  const { fx, app, res } = await payOnArc(t, env);
  assert.equal(res.status, 200);
  for (const call of [...circleCalls(fx, "verify"), ...circleCalls(fx, "settle")]) {
    assert.equal(call.headers.authorization, undefined);
    assert.ok(call.headers["facilitator-seller-proof"]);
  }
  const health = await (await request(app, "/health", env)).json();
  assert.deepEqual(health.arc, { auth: "seller-proof", payTo: SELLER, trialExhausted: false });
});

test("without a seller key, Arc falls back to the CIRCLE_API_KEY Bearer token", async (t) => {
  const { fx, app, res } = await payOnArc(t, fullEnv());
  assert.equal(res.status, 200);
  for (const call of [...circleCalls(fx, "verify"), ...circleCalls(fx, "settle")]) {
    assert.equal(call.headers.authorization, "Bearer test-circle-key");
    assert.equal(call.headers["facilitator-seller-proof"], undefined);
  }
  const health = await (await request(app, "/health", fullEnv())).json();
  assert.deepEqual(health.arc, { auth: "api-key", payTo: ADDR.arc });
});

test("/health reports a mismatched PAY_TO_ARC, a bad key and a missing key, and never shows the key", async (t) => {
  mockFacilitators(t);
  const arcSkip = async (env) => {
    const res = await request(createApp(), "/health", env);
    const text = await res.text();
    assert.equal(text.includes(SELLER_KEY.slice(2)), false, "the key never appears");
    const health = JSON.parse(text);
    assert.equal(health.networks.includes("arc"), false);
    assert.equal(health.arc, undefined);
    const unpaid = decodePaymentRequired(await request(createApp(), "/api/audit?url=example.com", env));
    assert.equal(unpaid.accepts.some((a) => a.network === ARC), false, "Arc is not offered");
    return health.skipped.find((s) => s.key === "arc").reason;
  };

  const mismatch = await arcSkip(keylessEnv({ PAY_TO_ARC: ADDR.arc }));
  assert.match(mismatch, /PAY_TO_ARC .* does not match the ARC_SELLER_KEY address/);
  assert.ok(mismatch.includes(ADDR.arc) && mismatch.includes(SELLER), mismatch);

  assert.match(await arcSkip(fullEnv({ CIRCLE_API_KEY: "" })), /neither the ARC_SELLER_KEY nor the CIRCLE_API_KEY secret is set/);
  assert.match(await arcSkip(fullEnv({ PAY_TO_ARC: "", CIRCLE_API_KEY: "" })), /ARC_SELLER_KEY secret is not set/);

  for (const bad of ["0x1234", `0x${"0".repeat(64)}`, `${SELLER_KEY}ff`]) {
    const reason = await arcSkip(keylessEnv({ ARC_SELLER_KEY: bad }));
    assert.match(reason, /ARC_SELLER_KEY is not a valid private key/);
    assert.equal(reason.includes(bad.slice(2)), false);
  }

  // A matching PAY_TO_ARC (any case) is fine, and so is a key without 0x.
  for (const env of [keylessEnv({ PAY_TO_ARC: SELLER.toLowerCase() }), keylessEnv({ ARC_SELLER_KEY: SELLER_KEY.slice(2) })]) {
    const health = await (await request(createApp(), "/health", env)).json();
    assert.ok(health.networks.includes("arc"));
    assert.equal(health.arc.payTo, SELLER);
  }
});

test("registration_required: logged, shown on /health, nobody is charged", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  let runs = 0;
  const env = keylessEnv({ AI: { run: async () => { runs++; return { data: [[0.1]], shape: [1, 1] }; } } });
  const trialOver = (body) => body.paymentRequirements.network === ARC
    ? json({ code: 403, message: "Registration required to continue settling on this address", errors: [{ reason: "registration_required" }] }, 403)
    : { success: true, transaction: "0xsettled", network: body.paymentRequirements.network, payer: "0x3333333333333333333333333333333333333333" };
  const { fx, app, unpaid, res } = await payOnArc(t, env, { settle: trialOver });

  assert.equal(res.status, 402, "no result without a settled payment");
  assert.equal((await res.text()).includes("embedding"), false);
  const receipt = JSON.parse(Buffer.from(res.headers.get("payment-response"), "base64").toString());
  assert.equal(receipt.success, false);
  assert.equal(receipt.errorReason, "registration_required");
  assert.ok(errors.mock.calls.some((c) => /keyless trial allowance .* used up .* registration_required/.test(c.arguments.join(" "))), "logged");

  const health = await (await request(app, "/health", env)).json();
  assert.equal(health.arc.trialExhausted, true);
  assert.match(health.arc.trialExhaustedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(health.arc.warning, /registration_required/);

  // Later Arc payments are refused before the handler runs; Base still works.
  const verifies = fx.verifies().length;
  const before = runs;
  const again = await embed(app, env, await evmPaymentHeader(unpaid, ARC));
  assert.equal(again.status, 402);
  assert.equal(runs, before, "handler not run");
  assert.equal(fx.verifies().length, verifies, "Circle not called");
  assert.equal((await embed(app, env, await evmPaymentHeader(unpaid, BASE))).status, 200);
  assert.equal(fx.settles().filter((c) => c.url.startsWith(CIRCLE_URL)).length, 1);
});

test("another 403 (e.g. below Circle's minimum) is not mistaken for the end of the trial", async (t) => {
  t.mock.method(console, "error", () => {});
  const env = keylessEnv();
  const { app, res } = await payOnArc(t, env, { settle: () => json({ code: 403, message: "Amount below the configured minimum" }, 403) });
  assert.equal(res.status, 402);
  const health = await (await request(app, "/health", env)).json();
  assert.equal(health.arc.trialExhausted, false);
});

test("keyless Arc: a failed handler never settles", async (t) => {
  const env = keylessEnv({ AI: { run: async () => { throw new Error("model down"); } } });
  const { fx, res } = await payOnArc(t, env);
  assert.equal(res.status, 503);
  assert.equal(circleCalls(fx, "verify").length, 1);
  assert.equal(fx.settles().length, 0);
});
