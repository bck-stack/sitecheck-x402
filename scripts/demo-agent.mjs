// Demo "agent": discovers SiteCheck through /.well-known/x402, pays for one website audit on the
// network you pick, and prints the result and the settlement transaction.
//
//   node scripts/demo-agent.mjs --network base|arc|solana [--site example.com] [--url https://...] [--dry-run]
//
// Keys live in git-ignored files and are created on the first run:
//   .env.evm     EVM private key (hex), used for Base and Arc
//   .env.solana  Solana keypair as a JSON array of 64 bytes (Solana CLI format)
// Fund the printed address with about 0.10 USDC (one audit costs 0.02). No ETH or SOL is needed:
// EVM payments are EIP-3009 signatures and the facilitator pays the Solana fee.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from "@solana/kit";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]] : null).filter(Boolean));
const API = String(args.url || process.env.SITECHECK_URL || "https://api.sitecheck-api.workers.dev").replace(/\/$/, "");
const SITE = args.site || "example.com";
const NETWORK = args.network;

// Per network: where to read the balance and where to show the transaction.
const CHAINS = {
  base: { rpc: process.env.BASE_RPC_URL || "https://mainnet.base.org", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tx: "https://basescan.org/tx/" },
  arc: { rpc: process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io", usdc: "0x3600000000000000000000000000000000000000", tx: "https://explorer.arc.io/tx/" },
  solana: { rpc: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tx: "https://solscan.io/tx/" },
};
if (!CHAINS[NETWORK]) {
  console.error("usage: node scripts/demo-agent.mjs --network base|arc|solana [--site example.com] [--url API] [--dry-run]");
  process.exit(1);
}
const chain = CHAINS[NETWORK];
const step = (n, text) => console.log(`\n[${n}] ${text}`);

// 1. Discover the API: which networks it accepts and what the audit costs.
step(1, `Discovering ${API}/.well-known/x402`);
const discovery = await (await fetch(`${API}/.well-known/x402`)).json();
const offer = discovery.networks?.find((n) => n.key === NETWORK);
const endpoint = discovery.endpoints?.find((e) => new URL(e.url).pathname === "/api/audit");
console.log(`    ${discovery.name}: ${discovery.endpoints?.length ?? 0} paid endpoints, networks: ${discovery.networks?.map((n) => n.name).join(", ") || "none"}`);
if (!offer) { console.error(`    This deployment does not accept ${NETWORK} yet.`); process.exit(1); }
if (!endpoint) { console.error("    /api/audit not found in discovery."); process.exit(1); }
if (offer.asset.toLowerCase() !== chain.usdc.toLowerCase()) { console.error(`    Unexpected asset ${offer.asset} on ${NETWORK}; refusing to pay.`); process.exit(1); }
console.log(`    Website audit costs ${endpoint.price} (${endpoint.amount} USDC base units) on ${offer.name} (${offer.network}), paid to ${offer.payTo}`);

// 2. Load (or create) the wallet for this network.
step(2, "Loading wallet");
let signer, owner;
if (NETWORK === "solana") {
  if (!existsSync(".env.solana")) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const s = await createKeyPairSignerFromPrivateKeyBytes(seed);
    writeFileSync(".env.solana", JSON.stringify([...seed, ...getAddressEncoder().encode(s.address)]));
    console.log("    Created a new Solana wallet in .env.solana");
  }
  signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(".env.solana", "utf8"))));
  owner = signer.address;
} else {
  if (!existsSync(".env.evm")) { writeFileSync(".env.evm", generatePrivateKey()); console.log("    Created a new EVM wallet in .env.evm"); }
  signer = privateKeyToAccount(readFileSync(".env.evm", "utf8").trim());
  owner = signer.address;
}
const balance = await usdcBalance(owner);
console.log(`    Address ${owner}, USDC on ${offer.name}: ${balance ?? "unknown"}`);

if (args["dry-run"]) { console.log("\n--dry-run: stopping before payment."); process.exit(0); }
if (balance !== null && balance * 1e6 < Number(endpoint.amount)) {
  console.error(`\n    Not enough USDC. Send about 0.10 USDC on ${offer.name} to ${owner} and run again.`);
  process.exit(1);
}

// 3. Pay and call. The x402 client answers the 402 with a signed payment for our network only.
step(3, `GET /api/audit?url=${SITE}, paying on ${offer.name}`);
const client = x402Client.fromConfig({
  schemes: [{ network: offer.network, client: NETWORK === "solana" ? new ExactSvmScheme(signer, { rpcUrl: chain.rpc }) : new ExactEvmScheme(signer) }],
  // Arc USDC is not in @x402/evm's built-in asset list, so opt in to it, capped at 0.10 USDC per call.
  ...(NETWORK === "arc" && { spendControls: { allowedAssets: [{ network: offer.network, asset: chain.usdc, maxAmountPerPayment: "100000" }] } }),
});
const pay = wrapFetchWithPayment(fetch, client);
const started = Date.now();
const res = await pay(`${API}/api/audit?url=${encodeURIComponent(SITE)}`);
const body = await res.json().catch(() => ({}));
const receiptHeader = res.headers.get("payment-response");
const receipt = receiptHeader ? decodePaymentResponseHeader(receiptHeader) : null;

step(4, `Result (HTTP ${res.status}, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
if (!res.ok) { console.log("    ", JSON.stringify(body).slice(0, 500)); process.exit(1); }
const a = body.accessibility || {};
console.log(`    ${body.url}: accessibility score ${a.score}/100, ${a.issues?.length ?? 0} issue types`);
for (const i of (a.issues || []).slice(0, 5)) console.log(`      - [${i.severity}] ${i.rule} (WCAG ${i.wcag}): ${i.detail}`);
console.log(`    Security headers: ${Object.entries(body.security || {}).map(([k, v]) => `${k} ${v ? "yes" : "no"}`).join(", ")}`);
console.log(`    Tech: ${(body.tech || []).join(", ") || "none detected"}`);

step(5, "Payment");
if (receipt?.transaction) {
  console.log(`    Settled on ${receipt.network}: ${receipt.transaction}`);
  console.log(`    ${chain.tx}${receipt.transaction}`);
} else console.log("    No settlement receipt in the response.");
const after = await usdcBalance(owner);
if (after !== null) console.log(`    USDC left: ${after}`);

async function usdcBalance(who) {
  try {
    if (NETWORK === "solana") {
      const r = await rpc(chain.rpc, "getTokenAccountsByOwner", [who, { mint: chain.usdc }, { encoding: "jsonParsed" }]);
      return r.value.reduce((sum, acc) => sum + Number(acc.account.data.parsed.info.tokenAmount.uiAmountString), 0);
    }
    const data = "0x70a08231" + who.slice(2).toLowerCase().padStart(64, "0"); // balanceOf(address)
    return Number(BigInt(await rpc(chain.rpc, "eth_call", [{ to: chain.usdc, data }, "latest"]))) / 1e6;
  } catch { return null; }
}
async function rpc(url, method, params) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
