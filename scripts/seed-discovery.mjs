// Pays once, with the demo wallet (.env.evm, USDC on Base), for every paid route that neither the Coinbase x402 Bazaar
// nor the PayAI discovery list shows yet, using the route's own documented example input. A facilitator lists an x402
// resource only after it has settled a payment for it, so new routes stay invisible to agents until then.
// The money goes to our own PAY_TO wallet.
//
//   node scripts/seed-discovery.mjs          # shows the plan and the total, pays nothing
//   node scripts/seed-discovery.mjs --yes    # pays (at most --max USDC, default 0.15)
import { readFileSync } from "node:fs";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const args = process.argv.slice(2);
const API = "https://api.sitecheck-api.workers.dev";
const MAX = Number(args[args.indexOf("--max") + 1]) || 0.15;
const BASE = "eip155:8453";
// Not seeded: the prediction-market buy routes need a live market, a wallet and an order.
const SKIP = new Set(["/api/markets/build-buy", "/api/markets/report", "/api/markets/quote"]);

// Base and Solana settle through Coinbase's CDP facilitator when its keys are set (they are), which catalogs routes in
// the x402 Bazaar; older settlements went through PayAI. A route counts as listed if either list has it.
const listed = new Set();
const add = (items) => { for (const i of items || []) if (String(i.resource || "").startsWith(API)) listed.add(new URL(i.resource).pathname); };
const getJson = async (url) => {
  for (let t = 0; t < 5; t++) {
    const r = await fetch(url).catch(() => null);
    if (r?.ok) return r.json();
    await new Promise((s) => setTimeout(s, 800 * (t + 1)));
  }
  return null;
};
const scan = async (base, pageSize, workers) => {
  const first = await getJson(`${base}?limit=${pageSize}&offset=0`);
  add(first?.items);
  const total = first?.pagination?.total ?? 0;
  const offsets = [];
  for (let o = pageSize; o < total; o += pageSize) offsets.push(o);
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < offsets.length) add((await getJson(`${base}?limit=${pageSize}&offset=${offsets[next++]}`))?.items);
  }));
};
await Promise.all([
  scan("https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources", 100, 5),
  scan("https://facilitator.payai.network/discovery/resources", 1000, 3),
]);
const spec = await (await fetch(`${API}/openapi.json`)).json();
const plan = [];
for (const [path, ops] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(ops)) {
    if (listed.has(path) || SKIP.has(path) || !op["x-payment-info"]) continue;
    const price = Number(op["x-payment-info"].price.amount);
    const query = new URLSearchParams(Object.fromEntries((op.parameters || []).filter((p) => p.example !== undefined).map((p) => [p.name, String(p.example)])));
    const body = op.requestBody?.content?.["application/json"]?.example;
    plan.push({ method: method.toUpperCase(), path, price, url: `${API}${path}${[...query].length ? `?${query}` : ""}`, body });
  }
}
const total = plan.reduce((s, p) => s + p.price, 0);
console.log(`Already listed (Bazaar or PayAI): ${[...listed].sort().join(", ") || "none"}`);
console.log(`To seed (${plan.length}, total $${total.toFixed(3)}):`);
for (const p of plan) console.log(`  $${p.price.toFixed(3)}  ${p.method} ${p.path}`);
if (!args.includes("--yes")) { console.log("\nNothing paid. Run again with --yes to pay."); process.exit(0); }
if (total > MAX) { console.error(`\nTotal $${total.toFixed(3)} is above the cap $${MAX}; use --max to raise it.`); process.exit(1); }

const signer = privateKeyToAccount(readFileSync(".env.evm", "utf8").trim());
const pay = wrapFetchWithPayment(fetch, x402Client.fromConfig({ schemes: [{ network: BASE, client: new ExactEvmScheme(signer) }] }));
let spent = 0, ok = 0;
for (const p of plan) {
  const res = await pay(p.url, p.body ? { method: p.method, headers: { "content-type": "application/json" }, body: JSON.stringify(p.body) } : { method: p.method });
  const receipt = res.headers.get("payment-response");
  const tx = receipt ? decodePaymentResponseHeader(receipt)?.transaction : null;
  await res.text();
  if (res.ok && tx) { ok++; spent += p.price; }
  console.log(`  ${res.ok && tx ? "paid" : `HTTP ${res.status}, not charged`}  ${p.method} ${p.path}${tx ? `  https://basescan.org/tx/${tx}` : ""}`);
}
console.log(`\nDone: ${ok}/${plan.length} paid, $${spent.toFixed(3)} spent (to our own PAY_TO). New entries appear in PayAI discovery within minutes.`);
