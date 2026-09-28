// x402 wiring: which facilitator and which scheme serve each network.
//   Base, Solana -> PayAI facilitator (FACILITATOR_URL), no key needed.
//   Arc          -> Circle Facilitator Service (FACILITATOR_URL_ARC): seller proofs signed with
//                   ARC_SELLER_KEY (keyless trial), or a CIRCLE_API_KEY Bearer token (lib/circle.js).
import { x402ResourceServer, x402HTTPResourceServer, paymentMiddlewareFromHTTPServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { convertToTokenAmount } from "@x402/core/utils";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { PAYAI_URL, CIRCLE_URL } from "./networks.js";
import { circleFacilitator } from "./circle.js";

// Both facilitators list Base, so each client only reports the networks we route to it.
// That keeps the routing explicit instead of depending on the order of the facilitator list.
export function scopedFacilitator(client, networks) {
  return {
    verify: (payload, requirements) => client.verify(payload, requirements),
    settle: (payload, requirements) => client.settle(payload, requirements),
    async getSupported() {
      const supported = await client.getSupported();
      return { ...supported, kinds: supported.kinds.filter((k) => networks.includes(k.network)) };
    },
  };
}

// arcState is shared by every client an app instance builds, so /health can report what Circle said.
export function facilitators(env, networks, arcState = {}) {
  const on = (name) => networks.filter((n) => n.facilitator === name).map((n) => n.network);
  const list = [];
  if (on("payai").length) {
    list.push(scopedFacilitator(new HTTPFacilitatorClient({ url: env.FACILITATOR_URL || PAYAI_URL }), on("payai")));
  }
  const arc = networks.find((n) => n.facilitator === "circle");
  if (arc) {
    // /supported is public; only /verify and /settle carry the proof or the key, so a bad key or
    // proof only breaks Arc payments, not the start-up of the other networks.
    const circle = circleFacilitator({ url: env.FACILITATOR_URL_ARC || CIRCLE_URL, signer: arc.signer, apiKey: env.CIRCLE_API_KEY, state: arcState });
    list.push(scopedFacilitator(circle, on("circle")));
  }
  return list;
}

// @x402/evm has no default USDC entry for Arc, so the "$0.02" prices are converted here.
function schemeFor(n) {
  if (n.key === "solana") return new ExactSvmScheme();
  const scheme = new ExactEvmScheme();
  if (n.eip712) {
    scheme.registerMoneyParser(async (amount, network) =>
      network === n.network ? { amount: convertToTokenAmount(amount, 6), asset: n.asset, extra: { ...n.eip712 } } : null);
  }
  return scheme;
}

export function resourceServer(env, networks, clients = facilitators(env, networks)) {
  const server = new x402ResourceServer(clients).registerExtension(bazaarResourceServerExtension);
  for (const n of networks) server.register(n.network, schemeFor(n));
  return server;
}

// Initialization is awaited here, inside the calling request (see createApp for why).
// Settlement runs after the handler, and only for responses below 400.
export async function createPaymentMiddleware(env, networks, routes, clients) {
  const http = new x402HTTPResourceServer(resourceServer(env, networks, clients), routes);
  await http.initialize();
  return paymentMiddlewareFromHTTPServer(http, undefined, undefined, false);
}
