// Payment networks. Each one is switched on by its receiving address in wrangler.toml [vars]
// (Arc also by the ARC_SELLER_KEY secret, see arc() below); a network that is off is hidden
// everywhere (402 accepts, discovery, landing page).
// Sources for every constant below: docs/NETWORKS.md.
import { sellerAccount } from "./sellerProof.js";

export const PAYAI_URL = "https://facilitator.payai.network";
export const CIRCLE_URL = "https://api.circle.com/v1/facilitator/x402";

export const NETWORKS = [
  {
    key: "base",
    name: "Base",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
    payToVar: "PAY_TO",
    facilitator: "payai",
    explorer: "https://basescan.org/tx/",
  },
  {
    key: "solana",
    name: "Solana",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mint
    payToVar: "PAY_TO_SOLANA",
    facilitator: "payai",
    explorer: "https://solscan.io/tx/",
  },
  {
    key: "arc",
    name: "Arc",
    network: "eip155:5042",
    // USDC's ERC-20 interface on Arc: 6 decimals, EIP-3009, EIP-712 domain name "USDC", version "2".
    asset: "0x3600000000000000000000000000000000000000",
    eip712: { name: "USDC", version: "2" },
    payToVar: "PAY_TO_ARC",
    facilitator: "circle",
    explorer: "https://explorer.arc.io/tx/",
  },
];

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const secret = (env, name) => String(env[name] ?? "").trim();

// Arc is switched on by the ARC_SELLER_KEY secret (keyless trial: payTo is that key's address and
// PAY_TO_ARC, if set, must match it) or, without a seller key, by PAY_TO_ARC plus CIRCLE_API_KEY.
function arc(n, env, payTo) {
  const key = secret(env, "ARC_SELLER_KEY");
  if (payTo && !EVM_ADDRESS.test(payTo)) return { reason: "PAY_TO_ARC is not a valid Arc address" };
  if (key) {
    const signer = sellerAccount(key);
    if (!signer) return { reason: "ARC_SELLER_KEY is not a valid private key (expected 32 bytes of hex)" };
    if (payTo && payTo.toLowerCase() !== signer.address.toLowerCase()) {
      return { reason: `PAY_TO_ARC (${payTo}) does not match the ARC_SELLER_KEY address (${signer.address}); clear PAY_TO_ARC or set it to that address` };
    }
    return { network: { ...n, payTo: signer.address, auth: "seller-proof", signer } };
  }
  if (!payTo) return { reason: "ARC_SELLER_KEY secret is not set and PAY_TO_ARC is empty" };
  if (!secret(env, "CIRCLE_API_KEY")) return { reason: "neither the ARC_SELLER_KEY nor the CIRCLE_API_KEY secret is set" };
  return { network: { ...n, payTo, auth: "api-key" } };
}

// Returns { active: [network + payTo], skipped: [{ key, reason }] } for this environment.
export function paymentNetworks(env = {}) {
  const active = [], skipped = [];
  for (const n of NETWORKS) {
    const payTo = String(env[n.payToVar] ?? "").trim();
    const valid = n.key === "solana" ? SOLANA_ADDRESS : EVM_ADDRESS;
    if (n.key === "arc") {
      const { network, reason } = arc(n, env, payTo);
      if (network) active.push(network); else skipped.push({ key: n.key, reason });
    } else if (!payTo) skipped.push({ key: n.key, reason: `${n.payToVar} is empty` });
    else if (!valid.test(payTo)) skipped.push({ key: n.key, reason: `${n.payToVar} is not a valid ${n.name} address` });
    else active.push({ ...n, payTo });
  }
  return { active, skipped };
}
