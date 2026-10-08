// GET / for browsers: one page with the tools, prices, networks, client examples and a live 402.
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const short = (a) => a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

const EVM_EXAMPLE = (origin, network, asset) => `import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

// A wallet holding a little USDC on ${asset ? "Arc" : "Base"}. No gas token needed.
const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
const client = x402Client.fromConfig({
  schemes: [{ network: "${network}", client: new ExactEvmScheme(account) }],${asset ? `
  // Arc USDC is not in @x402/evm's built-in asset list yet: opt in, capped at $0.10 per call.
  spendControls: {
    allowedAssets: [{ network: "${network}", asset: "${asset}", maxAmountPerPayment: "100000" }],
  },` : ""}
});
const pay = wrapFetchWithPayment(fetch, client);

const res = await pay("${origin}/api/audit?url=example.com");
console.log(await res.json());`;

const SOLANA_EXAMPLE = (origin, network) => `import { readFileSync } from "node:fs";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";

// A Solana CLI keypair file for a wallet holding a little USDC. Fees are paid by the facilitator.
const bytes = Uint8Array.from(JSON.parse(readFileSync("buyer.json", "utf8")));
const signer = await createKeyPairSignerFromBytes(bytes);
const client = new x402Client().register("${network}", new ExactSvmScheme(signer));
const pay = wrapFetchWithPayment(fetch, client);

const res = await pay("${origin}/api/audit?url=example.com");
console.log(await res.json());`;

// Shown only when the Panta tools are on (PANTA_API_KEY set). Panta's Terms require "Powered by Panta",
// linked to panta.market, next to the Panta-powered functionality.
function marketsSection(origin, endpoints) {
  if (!endpoints.length) return "";
  const rows = endpoints.map((e) => `<tr><td><code>${esc(e.method)} ${esc(new URL(e.url).pathname)}</code></td><td class="num">${esc(e.price)}</td><td>${esc(e.description)}</td></tr>`).join("")
    + `<tr><td><code>POST /api/markets/report</code></td><td class="num">free</td><td>After your wallet signed and broadcast a build-buy transaction, send the signature here so Panta confirms and attributes the trade.</td></tr>`;
  const example = `# 1. Search (pay $0.002): ids, odds, close times
GET ${origin}/api/markets?q=bitcoin&status=primary&limit=5

# 2. Brief (pay $0.01): odds, recent activity, a neutral summary
GET ${origin}/api/markets/brief?id=<market id>

# 3. Quote (pay $0.005): expected shares, fee, price impact
POST ${origin}/api/markets/quote
{ "id": "<market id>", "side": "yes", "amountUsdc": "5.00", "wallet": "<your Solana wallet>" }

# 4. Build (pay $0.01): an unsigned transaction for your wallet
POST ${origin}/api/markets/build-buy   (same body)

# 5. Your agent signs and broadcasts it, then reports the signature (free)
POST ${origin}/api/markets/report
{ "signature": "<tx signature>", "orderId": "ord_...", "quoteId": "qt_...", "id": "<market id>", "wallet": "<your wallet>" }`;
  return `
<h2 id="markets">Prediction markets (Panta)</h2>
<p>Market intelligence and ready-to-sign trade transactions, paid per call. An agent researching an event pays a cent and gets the crowd's odds on Panta's USDC prediction markets on Solana. An agent that wants to act pays for an unsigned buy transaction and signs it with its own wallet.</p>
<div class="table tools"><table>
<thead><tr><th>Endpoint</th><th>Price</th><th>What it does</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<pre><code>${esc(example)}</code></pre>
<p class="note"><strong>No custody.</strong> SiteCheck never signs, holds keys or custodies funds. <code>build-buy</code> returns an unsigned transaction; nothing happens until the agent's own wallet signs and broadcasts it. Every answer is information only, not financial advice.</p>
<p class="powered"><a href="https://panta.market">Powered by Panta</a></p>`;
}

export function landingPage({ origin, about, endpoints, marketEndpoints = [], networks, repo }) {
  const byKey = Object.fromEntries(networks.map((n) => [n.key, n]));
  const tabs = [
    byKey.base && { id: "base", label: "Base", code: EVM_EXAMPLE(origin, byKey.base.network) },
    byKey.arc && { id: "arc", label: "Arc", code: EVM_EXAMPLE(origin, byKey.arc.network, byKey.arc.asset) },
    byKey.solana && { id: "solana", label: "Solana", code: SOLANA_EXAMPLE(origin, byKey.solana.network) },
  ].filter(Boolean);
  const curl = `curl -si "${origin}/api/audit?url=example.com" \\
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\\r' | base64 -d`;

  const toolRows = endpoints.map((e) => `<tr><td><code>${esc(e.method)} ${esc(new URL(e.url).pathname)}</code></td><td class="num">${esc(e.price)}</td><td>${esc(e.description)}</td></tr>`).join("");
  const netRows = networks.length
    ? networks.map((n) => `<tr><td><strong>${esc(n.name)}</strong></td><td><code>${esc(n.network)}</code></td><td><code title="${esc(n.asset)}">${esc(short(n.asset))}</code></td><td>${esc(n.facilitator)}</td><td><code title="${esc(n.payTo)}">${esc(short(n.payTo))}</code></td></tr>`).join("")
    : `<tr><td colspan="5">No payment network is configured on this deployment yet.</td></tr>`;
  const chips = networks.map((n) => `<span class="chip">${esc(n.name)}</span>`).join("");
  const tabButtons = tabs.map((t, i) => `<button type="button" role="tab" id="tab-${t.id}" aria-controls="pane-${t.id}" aria-selected="${i === 0}" data-tab="${t.id}">${esc(t.label)}</button>`).join("");
  const tabPanes = tabs.map((t, i) => `<div role="tabpanel" id="pane-${t.id}" aria-labelledby="tab-${t.id}"${i ? " hidden" : ""}><pre><code>${esc(t.code)}</code></pre></div>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SiteCheck API</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="description" content="${esc(about)}">
<style>
:root{--bg:#fbfbfa;--fg:#17171a;--muted:#5d5d66;--line:#e3e3df;--card:#fff;--code:#f2f2ef;--accent:#1f5eff;--accent-fg:#fff;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111114;--fg:#ececef;--muted:#a0a0aa;--line:#2a2a31;--card:#18181c;--code:#202026;--accent:#7aa2ff;--accent-fg:#0b0b0e;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:40px 16px 64px}
h1{font-size:2rem;line-height:1.2;margin:0 0 8px}
h2{font-size:1.15rem;margin:40px 0 12px}
p{margin:0 0 12px}
a{color:var(--accent)}
.lead{color:var(--muted);max-width:68ch}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 0}
.chip{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:2px 12px;font-size:.9rem}
.proof{margin:14px 0 0;font-size:.95rem;color:var(--muted, inherit)}
ol.steps{padding-left:20px;margin:0}
ol.steps li{margin:4px 0}
.table{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:.95rem}
th,td{text-align:left;padding:10px 12px;border-top:1px solid var(--line);vertical-align:top}
thead th{border-top:0;color:var(--muted);font-weight:600;font-size:.85rem}
td.num{white-space:nowrap;font-variant-numeric:tabular-nums}
code{font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
td code{white-space:nowrap}
pre{margin:0;background:var(--code);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;font-size:.9rem;line-height:1.5}
[role=tablist]{display:flex;gap:4px;margin-bottom:8px}
[role=tab]{font:inherit;font-size:.9rem;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:4px 14px;cursor:pointer}
[role=tab][aria-selected=true]{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
button.run{font:inherit;border:0;border-radius:8px;padding:8px 16px;background:var(--accent);color:var(--accent-fg);cursor:pointer;margin:12px 0}
#out{min-height:3em;white-space:pre-wrap}
.muted{color:var(--muted);font-size:.92rem}
footer{margin-top:48px;color:var(--muted);font-size:.9rem}
.nets table{min-width:640px}
.note{border-left:3px solid var(--accent);padding:8px 12px;background:var(--card);border-radius:0 8px 8px 0;margin:12px 0}
.powered{font-weight:600;margin:8px 0 0}
@media (max-width:640px){
h1{font-size:1.6rem}
.tools thead{display:none}
.tools tbody,.tools tr,.tools td{display:block}
.tools tr{display:grid;grid-template-columns:1fr auto;border-top:1px solid var(--line)}
.tools tr:first-child{border-top:0}
.tools td{border-top:0;padding:10px 12px 0}
.tools td:nth-child(3){grid-column:1/-1;padding:4px 12px 12px;color:var(--muted)}
}
</style>
</head>
<body>
<main>
<header>
<h1>SiteCheck API</h1>
<p class="lead">${esc(about)}</p>
<div class="chips" aria-label="Accepted networks">${chips}</div>
<p class="proof">Already paid for from outside wallets: 15 paid calls in USDC on Base (29 Sep – 8 Oct 2026), most of them by an autonomous AI agent with no human in the loop. <a href="https://basescan.org/tx/0x34751591863f024816f198621c75002be283be874fbd311620473e69ab2c2d87">Verify the latest on chain</a>.</p>
</header>

<h2>How it works</h2>
<ol class="steps">
<li>Call any endpoint. The first answer is <code>402 Payment Required</code>, with one payment option per network in the <code>PAYMENT-REQUIRED</code> header.</li>
<li>Your x402 client signs a USDC transfer for the listed price on the network it has funds on and sends the request again.</li>
<li>You get the result. Payment settles only after the tool succeeds: if a tool or model fails, the call returns an error and nothing is charged.</li>
</ol>

<h2>Tools and prices</h2>
<div class="table tools"><table>
<thead><tr><th>Endpoint</th><th>Price</th><th>What it does</th></tr></thead>
<tbody>${toolRows}</tbody>
</table></div>
<p class="muted">Prices are in US dollars and paid in USDC. The price is the same on every network.</p>
${marketsSection(origin, marketEndpoints)}

<h2>Networks</h2>
<div class="table nets"><table>
<thead><tr><th>Network</th><th>CAIP-2 id</th><th>USDC</th><th>Facilitator</th><th>Pays to</th></tr></thead>
<tbody>${netRows}</tbody>
</table></div>
<p class="muted">The buyer never needs a gas token: EVM payments are EIP-3009 signatures and Solana fees are paid by the facilitator.</p>

<h2>Try it</h2>
<p>This asks for a website audit without paying and decodes the 402 answer:</p>
<pre><code>${esc(curl)}</code></pre>
<button type="button" class="run" id="run">Run it from this page</button>
<pre id="out" aria-live="polite"><code class="muted">The decoded 402 response will appear here.</code></pre>

<h2>Pay from code</h2>
${tabs.length ? `<div role="tablist" aria-label="Client examples">${tabButtons}</div>${tabPanes}` : `<p class="muted">Client examples appear once a network is configured.</p>`}
<p class="muted">Install with <code>npm i @x402/fetch @x402/evm viem</code> (Base, Arc) or <code>npm i @x402/fetch @x402/svm @solana/kit</code> (Solana). A complete agent that discovers the API and pays on the network you pick: <a href="${esc(repo)}/blob/main/scripts/demo-agent.mjs"><code>scripts/demo-agent.mjs</code></a>.</p>

<h2>Discovery</h2>
<p><a href="/.well-known/x402"><code>/.well-known/x402</code></a> · <a href="/openapi.json"><code>/openapi.json</code></a> · MCP server: <code>POST /mcp</code> (every tool, paid with the x402 MCP transport) · every 402 carries an x402 Bazaar input schema and output example, so agents can call it without reading docs.</p>

<footer>Open source (MIT): <a href="${esc(repo)}">${esc(repo.replace("https://", ""))}</a>. Runs on Cloudflare Workers and Workers AI.${marketEndpoints.length ? ` Prediction-market data and transactions: <a href="https://panta.market">Powered by Panta</a>.` : ""}</footer>
</main>
<script>
document.querySelectorAll('[role=tab]').forEach(function (tab) {
  tab.addEventListener('click', function () {
    document.querySelectorAll('[role=tab]').forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on);
      document.getElementById('pane-' + t.dataset.tab).hidden = !on;
    });
  });
});
document.getElementById('run').addEventListener('click', async function () {
  var out = document.getElementById('out');
  out.textContent = 'Requesting /api/audit?url=example.com ...';
  try {
    var res = await fetch('/api/audit?url=example.com', { headers: { accept: 'application/json' } });
    var header = res.headers.get('payment-required');
    var bin = header ? atob(header) : '';
    var text = header ? new TextDecoder().decode(Uint8Array.from(bin, function (ch) { return ch.charCodeAt(0); })) : '';
    var body = header ? JSON.parse(text) : await res.json();
    if (body.accepts) body = { x402Version: body.x402Version, error: body.error, accepts: body.accepts };
    out.textContent = 'HTTP ' + res.status + '\\n' + JSON.stringify(body, null, 2);
  } catch (e) { out.textContent = 'Request failed: ' + e.message; }
});
</script>
</body>
</html>`;
}
