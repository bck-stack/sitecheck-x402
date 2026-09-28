// Test helpers: a fake fetch that plays both facilitators, so no test touches the network.
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../lib/app.js";
import { PAYAI_URL, CIRCLE_URL } from "../lib/networks.js";

export const BASE = "eip155:8453";
export const ARC = "eip155:5042";
export const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const ARC_USDC = "0x3600000000000000000000000000000000000000";

export const ADDR = {
  base: "0x1111111111111111111111111111111111111111",
  arc: "0x2222222222222222222222222222222222222222",
  solana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
};
export const FEE_PAYER = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";

export const fullEnv = (extra = {}) => ({
  PAY_TO: ADDR.base, PAY_TO_SOLANA: ADDR.solana, PAY_TO_ARC: ADDR.arc, CIRCLE_API_KEY: "test-circle-key",
  AI: { run: async () => ({ data: [[0.1, 0.2]], shape: [1, 2] }) },
  ...extra,
});

// Keyless trial: a throwaway seller key; Arc's payTo becomes its address.
export const SELLER_KEY = generatePrivateKey();
export const SELLER = privateKeyToAccount(SELLER_KEY).address;
export const keylessEnv = (extra = {}) => fullEnv({ PAY_TO_ARC: "", CIRCLE_API_KEY: "", ARC_SELLER_KEY: SELLER_KEY, ...extra });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Replaces globalThis.fetch. Facilitator calls are answered and recorded; anything else fails.
// `raw` keeps the request body exactly as sent (bytes), for checking seller proofs.
export function mockFacilitators(t, { settle } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const raw = typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body;
    const body = raw ? JSON.parse(new TextDecoder().decode(raw)) : undefined;
    calls.push({ url, method: init.method || "GET", headers, body, raw });
    if (url === `${PAYAI_URL}/supported`) {
      return json({
        kinds: [
          { x402Version: 2, scheme: "exact", network: BASE },
          { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: FEE_PAYER } },
        ],
        extensions: ["bazaar"], signers: {},
      });
    }
    if (url === `${CIRCLE_URL}/supported`) {
      // Circle also lists Base: the scoped client must ignore it.
      return json({
        x402Version: 2,
        kinds: [
          { x402Version: 2, scheme: "exact", network: ARC, extra: { name: "USDC", version: "2" } },
          { x402Version: 2, scheme: "exact", network: BASE, extra: { name: "USD Coin", version: "2" } },
        ],
        extensions: ["payment-identifier", "settlement-status"], signers: {},
      });
    }
    if (url.endsWith("/verify")) return json({ isValid: true, payer: "0x3333333333333333333333333333333333333333" });
    if (url.endsWith("/settle")) {
      const answer = settle ? settle(body) : { success: true, transaction: "0xsettled", network: body.paymentRequirements.network, payer: "0x3333333333333333333333333333333333333333" };
      return answer instanceof Response ? answer : json(answer);
    }
    throw new Error(`unexpected network call in test: ${url}`);
  };
  t.after(() => { globalThis.fetch = real; });
  return {
    calls,
    settles: () => calls.filter((c) => c.url.endsWith("/settle")),
    verifies: () => calls.filter((c) => c.url.endsWith("/verify")),
  };
}

export { json };
export const request = (app, path, env, init) => app.request(path, init, env);

export function decodePaymentRequired(res) {
  const header = res.headers.get("payment-required");
  if (!header) throw new Error(`no PAYMENT-REQUIRED header (status ${res.status})`);
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

// Signs a real EIP-3009 authorization (offline) for the given network's option in a 402.
const buyer = privateKeyToAccount(generatePrivateKey());
export async function evmPaymentHeader(paymentRequired, network) {
  // Arc USDC is not in @x402/evm's default asset list, so buyers opt in to it explicitly.
  const client = x402Client.fromConfig({ schemes: [{ network, client: new ExactEvmScheme(buyer) }], spendControls: { allowedAssets: [{ network: ARC, asset: ARC_USDC }] } });
  const http = new x402HTTPClient(client);
  const payload = await http.createPaymentPayload({ ...paymentRequired, accepts: paymentRequired.accepts.filter((a) => a.network === network) });
  return http.encodePaymentSignatureHeader(payload);
}

// Solana payloads need an RPC to build; the mock facilitator accepts any transaction string.
export function solanaPaymentHeader(paymentRequired) {
  const accepted = paymentRequired.accepts.find((a) => a.network === SOLANA);
  const payload = { x402Version: 2, resource: paymentRequired.resource, accepted, payload: { transaction: "dGVzdA==" } };
  return { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") };
}

export { createApp };
