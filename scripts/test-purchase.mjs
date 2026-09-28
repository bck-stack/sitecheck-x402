// End-to-end test with real payments. The test wallet key lives in .env.alici (never committed).
// Usage: node scripts/test-purchase.mjs adres  -> prints the wallet address and USDC balance
//        node scripts/test-purchase.mjs al     -> buys each service once
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

const B = "https://api.sitecheck-api.workers.dev";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
let pk = existsSync(".env.alici") ? readFileSync(".env.alici", "utf8").trim() : null;
if (!pk) { pk = generatePrivateKey(); writeFileSync(".env.alici", pk); }
const account = privateKeyToAccount(pk);

async function balance() {
  const data = "0x70a08231" + account.address.slice(2).toLowerCase().padStart(64, "0");
  const r = await fetch("https://mainnet.base.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC, data }, "latest"] }) });
  return Number(BigInt((await r.json()).result)) / 1e6;
}

console.log("test wallet:", account.address, "· USDC:", await balance());
if (process.argv[2] !== "al") process.exit(0);

const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }] });
const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const calls = [
  ["/api/embed", post({ text: "hello world" })],
  ["/api/image", post({ prompt: "a lighthouse at dawn, photo", steps: 4 })],
  ["/api/chat", post({ prompt: "Say hello in five words.", max_tokens: 20 })],
  ["/api/transcribe", post({ url: "https://raw.githubusercontent.com/openai/whisper/main/tests/jfk.flac" })],
  ["/api/tts", post({ text: "Hello from SiteCheck." })],
  ["/api/contacts?url=plausible.io"],
  ["/api/hiring?q=python&limit=2"],
  ["/api/audit?url=example.com"],
];
for (const [path, init] of calls) {
  try {
    const r = await pay(B + path, init);
    const t = await r.text();
    console.log(r.status, path, t.slice(0, 120).replace(/\s+/g, " "));
  } catch (e) { console.log("HATA", path, e.message); }
}
console.log("kalan USDC:", await balance());
