// Payment networks. Each one is switched on by its receiving address in wrangler.toml [vars];
// an empty address hides the network everywhere (402 accepts, discovery, landing page).
// Sources for every constant below: docs/NETWORKS.md.

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

// Returns { active: [network + payTo], skipped: [{ key, reason }] } for this environment.
export function paymentNetworks(env = {}) {
  const active = [], skipped = [];
  for (const n of NETWORKS) {
    const payTo = String(env[n.payToVar] ?? "").trim();
    const valid = n.key === "solana" ? SOLANA_ADDRESS : EVM_ADDRESS;
    if (!payTo) skipped.push({ key: n.key, reason: `${n.payToVar} is empty` });
    else if (!valid.test(payTo)) skipped.push({ key: n.key, reason: `${n.payToVar} is not a valid ${n.name} address` });
    else if (n.facilitator === "circle" && !String(env.CIRCLE_API_KEY ?? "").trim()) skipped.push({ key: n.key, reason: "CIRCLE_API_KEY secret is not set" });
    else active.push({ ...n, payTo });
  }
  return { active, skipped };
}
