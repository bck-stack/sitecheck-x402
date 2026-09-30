// Demo "agent" for the prediction-market tools (powered by Panta). It pays per call with x402:
//   1. GET  /api/markets?q=...        ($0.002) search Panta's markets, with live odds
//   2. picks a market (the first open one, or --market <id>)
//   3. GET  /api/markets/brief        ($0.01)  odds, recent activity and a neutral summary
//   4. POST /api/markets/quote        ($0.005) expected fill and price impact for a small YES/NO buy
//   5. with --build: POST /api/markets/build-buy ($0.01) the unsigned buy transaction, printed, not signed
// It never signs or broadcasts a trade: it only demonstrates research, quoting and building.
// Information only, not financial advice.
//
//   node scripts/demo-markets.mjs [--network solana|base|arc] [--q "bitcoin"] [--market <id>] [--side yes|no]
//                                 [--amount 1.00] [--build] [--url https://...] [--dry-run]
//
// Keys live in git-ignored files, created on the first run (same as scripts/demo-agent.mjs):
//   .env.solana  Solana keypair (JSON array of 64 bytes). Pays on Solana, and is the wallet named in the quote.
//   .env.evm     EVM private key, only for --network base or arc.
// Fund the paying wallet with about 0.10 USDC. No SOL or ETH is needed: the facilitator pays the fees.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from "@solana/kit";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]] : null).filter(Boolean));
const API = String(args.url || process.env.SITECHECK_URL || "https://api.sitecheck-api.workers.dev").replace(/\/$/, "");
const NETWORK = args.network || "solana";
const Q = typeof args.q === "string" ? args.q : "bitcoin";
const SIDE = args.side === "no" ? "no" : "yes";
const AMOUNT = typeof args.amount === "string" ? args.amount : "1.00";

const CHAINS = {
  solana: { rpc: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tx: "https://solscan.io/tx/" },
  base: { usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tx: "https://basescan.org/tx/" },
  arc: { usdc: "0x3600000000000000000000000000000000000000", tx: "https://explorer.arc.io/tx/" },
};
if (!CHAINS[NETWORK]) {
  console.error("usage: node scripts/demo-markets.mjs [--network solana|base|arc] [--q bitcoin] [--market <id>] [--side yes|no] [--amount 1.00] [--build] [--url API] [--dry-run]");
  process.exit(1);
}
const chain = CHAINS[NETWORK];
const step = (n, text) => console.log(`\n[${n}] ${text}`);
const pct = (p) => (p === null || p === undefined ? "n/a" : `${(p * 100).toFixed(1)}%`);
let spent = 0;

// 0. Discovery: which networks this deployment takes, and whether the market tools are on.
step(0, `Discovering ${API}/.well-known/x402`);
const discovery = await (await fetch(`${API}/.well-known/x402`)).json();
const offer = discovery.networks?.find((n) => n.key === NETWORK);
const price = (path) => discovery.endpoints?.find((e) => new URL(e.url).pathname === path);
if (!price("/api/markets")) { console.error("    The prediction-market tools are not enabled on this deployment (see /health)."); process.exit(1); }
if (!offer) { console.error(`    This deployment does not accept ${NETWORK}.`); process.exit(1); }
if (offer.asset.toLowerCase() !== chain.usdc.toLowerCase()) { console.error(`    Unexpected asset ${offer.asset} on ${NETWORK}; refusing to pay.`); process.exit(1); }
for (const p of ["/api/markets", "/api/markets/brief", "/api/markets/quote", "/api/markets/build-buy"]) console.log(`    ${price(p).method.padEnd(4)} ${p.padEnd(24)} ${price(p).price}`);
console.log(`    Paying on ${offer.name} (${offer.network}) to ${offer.payTo}`);

// Wallets: the Solana one is also the buyer named in the quote (Panta markets are on Solana).
if (!existsSync(".env.solana")) {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const s = await createKeyPairSignerFromPrivateKeyBytes(seed);
  writeFileSync(".env.solana", JSON.stringify([...seed, ...getAddressEncoder().encode(s.address)]));
  console.log("    Created a new Solana wallet in .env.solana");
}
const solana = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(".env.solana", "utf8"))));
let scheme;
if (NETWORK === "solana") scheme = new ExactSvmScheme(solana, { rpcUrl: chain.rpc });
else {
  if (!existsSync(".env.evm")) { writeFileSync(".env.evm", generatePrivateKey()); console.log("    Created a new EVM wallet in .env.evm"); }
  scheme = new ExactEvmScheme(privateKeyToAccount(readFileSync(".env.evm", "utf8").trim()));
}
console.log(`    Buyer wallet for quotes: ${solana.address}`);
if (args["dry-run"]) { console.log("\n--dry-run: stopping before any payment."); process.exit(0); }

const client = x402Client.fromConfig({
  schemes: [{ network: offer.network, client: scheme }],
  // Arc USDC is not in @x402/evm's built-in asset list, so opt in, capped at 0.10 USDC per call.
  ...(NETWORK === "arc" && { spendControls: { allowedAssets: [{ network: offer.network, asset: chain.usdc, maxAmountPerPayment: "100000" }] } }),
});
const pay = wrapFetchWithPayment(fetch, client);

// One paid call: prints the HTTP status, the settlement transaction and the body's key facts.
async function call(label, path, init) {
  const started = Date.now();
  const res = await pay(`${API}${path}`, init);
  const body = await res.json().catch(() => ({}));
  const receipt = res.headers.get("payment-response") ? decodePaymentResponseHeader(res.headers.get("payment-response")) : null;
  console.log(`    HTTP ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (receipt?.transaction) {
    const e = discovery.endpoints.find((x) => new URL(x.url).pathname === path.split("?")[0]);
    spent += Number(e?.amount || 0) / 1e6;
    console.log(`    Paid ${e?.price} for ${label}: ${chain.tx}${receipt.transaction}`);
  }
  if (!res.ok) { console.log(`    ${body.error || JSON.stringify(body).slice(0, 300)}`); console.log("    (a failed call is not settled, so it was not charged)"); process.exit(1); }
  return body;
}
const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// 1. Search.
step(1, `GET /api/markets?q=${Q}`);
const found = await call("the search", `/api/markets?q=${encodeURIComponent(Q)}&limit=5`);
console.log(`    ${found.total} matching markets (${found.scanned} scanned)`);
for (const m of found.results) {
  console.log(`    - ${m.question}`);
  console.log(`      ${m.id} · ${m.phase} · YES ${pct(m.impliedProbability?.yes)} / NO ${pct(m.impliedProbability?.no)} · volume ${m.volumeUsdc ?? "n/a"} USDC · closes ${m.closesAt?.slice(0, 10) ?? "n/a"}`);
}

// 2. Pick one.
const market = args.market ? { id: args.market } : found.results.find((m) => m.buyable) || found.results[0];
if (!market) { console.log(`\n    No market matches "${Q}". Try another --q.`); process.exit(0); }
step(2, `Picked ${market.id}${market.question ? `: ${market.question}` : ""}`);

// 3. Brief.
step(3, "GET /api/markets/brief");
const brief = await call("the brief", `/api/markets/brief?id=${encodeURIComponent(market.id)}`);
const m = brief.market;
console.log(`    ${m.question}`);
console.log(`    Odds: YES ${pct(m.impliedProbability?.yes)} / NO ${pct(m.impliedProbability?.no)} (prices ${m.priceUsdc?.yes ?? "n/a"} / ${m.priceUsdc?.no ?? "n/a"} USDC)`);
if (brief.recentActivity) console.log(`    Recent trades: ${brief.recentActivity.sampled} sampled, ${brief.recentActivity.yesBuys} YES / ${brief.recentActivity.noBuys} NO, ${brief.recentActivity.last24h} in the last 24 h`);
console.log(`    Summary (${brief.summary.source}): ${brief.summary.text}`);

// 4. Quote.
const order = { id: market.id, side: SIDE, amountUsdc: AMOUNT, wallet: solana.address };
step(4, `POST /api/markets/quote ${JSON.stringify({ side: SIDE, amountUsdc: AMOUNT })}`);
const quote = await call("the quote", "/api/markets/quote", post(order));
const f = quote.expectedFill;
console.log(`    ${AMOUNT} USDC on ${SIDE.toUpperCase()} would buy about ${f.shares} shares at an average ${f.avgPrice} USDC, fee ${f.feeUsdc} USDC`);
console.log(`    Spot price ${quote.spotPrice ?? "n/a"}, price impact ${quote.priceImpact === null ? "n/a" : pct(quote.priceImpact)}`);

// 5. Optional: build the unsigned transaction. Printed only: this script never signs or broadcasts.
if (args.build) {
  step(5, "POST /api/markets/build-buy (the transaction is printed, never signed or sent)");
  const built = await call("the unsigned transaction", "/api/markets/build-buy", post(order));
  console.log(`    Order ${built.order.orderId}: ${built.order.expectedShares} shares expected, fee ${built.order.feeUsdc} USDC`);
  console.log(`    Unsigned ${built.transaction.format} transaction, ${built.transaction.data ? Buffer.from(built.transaction.data, "base64").length : "?"} bytes, signed: ${built.transaction.signed}, signer: ${built.transaction.requiredSigners.join(", ")}`);
  console.log(`    ${built.instructions.length} instructions from Panta; blockhash valid for about ${built.transaction.blockhashExpiryHintSec} s`);
  console.log("    Not signed and not broadcast: a real agent would sign it with its own wallet, send it, then POST /api/markets/report.");
}

console.log(`\nDone. Paid ${spent.toFixed(3)} USDC in total on ${offer.name}. ${brief.disclaimer} ${brief.poweredBy.text} (${brief.poweredBy.url}).`);
