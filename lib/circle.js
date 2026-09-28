// Circle Facilitator Service client for Arc.
// Authentication, chosen per deployment:
//   ARC_SELLER_KEY set -> keyless trial: a fresh seller proof on every /verify and /settle (lib/sellerProof.js).
//   otherwise          -> CIRCLE_API_KEY as a Bearer token.
// Circle rejects a request that carries both, so exactly one is sent. The client serializes the body
// itself and sends the very bytes the proof hashed; @x402/core's HTTPFacilitatorClient builds its
// body internally, which a proof can't be bound to.
import { HTTPFacilitatorClient } from "@x402/core/server";
import { SettleError, VerifyError } from "@x402/core/types";
import { sellerProof, SELLER_PROOF_HEADER } from "./sellerProof.js";

const TIMEOUT_MS = 90_000; // same default as HTTPFacilitatorClient
const bigints = (_, v) => (typeof v === "bigint" ? v.toString() : v);
const excerpt = (text) => (text.trim().replace(/\s+/g, " ").slice(0, 200) || "<empty response>");
// Circle's error body: { code, message, errors: [{ reason }] }
const reasons = (data) => (Array.isArray(data?.errors) ? data.errors.map((e) => e?.reason) : []);

export const TRIAL_EXHAUSTED =
  "Circle's keyless trial allowance for the Arc receiving address is used up (403 registration_required). " +
  "Arc payments can't settle until the owner adds a Circle API key or switches Arc off.";

// state: shared per app instance; { trialExhaustedAt } is set on the first registration_required.
export function circleFacilitator({ url, apiKey, signer, state = {} }) {
  const base = url.replace(/\/+$/, "");
  const publicClient = new HTTPFacilitatorClient({ url: base }); // /supported is public: no auth sent

  async function post(purpose, payload, requirements) {
    const body = new TextEncoder().encode(JSON.stringify({ x402Version: payload.x402Version, paymentPayload: payload, paymentRequirements: requirements }, bigints));
    const auth = signer
      ? { [SELLER_PROOF_HEADER]: await sellerProof(signer, { purpose, method: "POST", body, network: requirements.network, payTo: requirements.payTo }) }
      : { Authorization: `Bearer ${String(apiKey).trim()}` };
    const res = await fetch(`${base}/${purpose}`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { /* reported below */ }

    if (res.ok && typeof data?.[purpose === "verify" ? "isValid" : "success"] === "boolean") return data;
    if (res.status === 403 && reasons(data).includes("registration_required")) {
      if (!state.trialExhaustedAt) {
        state.trialExhaustedAt = new Date().toISOString();
        console.error(`[arc] ${TRIAL_EXHAUSTED} payTo=${requirements.payTo} network=${requirements.network}`);
      }
      throw new SettleError(403, { success: false, errorReason: "registration_required", errorMessage: TRIAL_EXHAUSTED, transaction: "", network: requirements.network });
    }
    console.error(`[arc] Circle ${purpose} answered ${res.status}: ${excerpt(text)}`);
    if (purpose === "verify" && data && "isValid" in data) throw new VerifyError(res.status, data);
    if (purpose === "settle" && data && "success" in data) throw new SettleError(res.status, data);
    throw new Error(`Circle ${purpose} failed (${res.status}): ${excerpt(text)}`);
  }

  return {
    async verify(payload, requirements) {
      // Once this instance has seen the trial run out, refuse before the handler runs:
      // the payment could not settle, so the buyer would wait for a result they can't get.
      if (state.trialExhaustedAt) throw new Error(TRIAL_EXHAUSTED);
      return post("verify", payload, requirements);
    },
    settle: (payload, requirements) => post("settle", payload, requirements),
    getSupported: () => publicClient.getSupported(),
  };
}
