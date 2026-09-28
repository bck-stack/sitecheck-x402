# SiteCheck: pay-per-call tools for AI agents (x402 on Base, Solana and Arc)

**Live:** https://api.sitecheck-api.workers.dev · listed on [x402scan](https://www.x402scan.com) · discovery: `/.well-known/x402`, `/openapi.json`

SiteCheck is a small API that AI agents can use **without an account or API key**. Every call is paid per request in **USDC** with the [x402](https://x402.org) protocol, on **Base**, **Solana** or **Arc** (Circle's L1), whichever the buyer holds USDC on. Call it, get a `402 Payment Required` listing the price on each network, sign the payment and get the result. It runs on Cloudflare Workers and Workers AI.

| Endpoint | Price | What it does |
|---|---|---|
| `GET /api/audit?url=` | $0.02 | Website audit: WCAG 2.2 accessibility issues with fixes and a score (European Accessibility Act), SEO basics, security headers, tech stack |
| `GET /api/contacts?url=` | $0.01 | Company contact enrichment from a domain: emails, phones, socials, tech |
| `GET /api/hiring?q=&remote=` | $0.01 | Searches the current Hacker News "Who is hiring?" thread |
| `POST /api/chat` | $0.004 | Llama 3.3 70B chat completion |
| `POST /api/image` | $0.005 | FLUX.1 schnell text-to-image |
| `POST /api/transcribe` | $0.01 | Whisper large-v3-turbo speech-to-text |
| `POST /api/tts` | $0.02 | Deepgram Aura-2 text-to-speech |
| `POST /api/embed` | $0.001 | BGE-M3 embeddings (1024-d, multilingual) |

## Networks

| Network | CAIP-2 | USDC | Facilitator |
|---|---|---|---|
| Base | `eip155:8453` | `0x8335…2913` | [PayAI](https://facilitator.payai.network) |
| Solana | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `EPjF…Dt1v` | [PayAI](https://facilitator.payai.network) |
| Arc | `eip155:5042` | `0x3600…0000` | [Circle Facilitator Service](https://developers.circle.com/facilitator-service) |

The price is the same on every network. Buyers need only USDC: EVM payments are EIP-3009 signatures, and the facilitator pays gas and Solana fees. Sources and design decisions: [docs/NETWORKS.md](docs/NETWORKS.md).

## Try it

```bash
curl -si "https://api.sitecheck-api.workers.dev/api/audit?url=example.com" \
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d
# {"x402Version":2,"error":"Payment required", ..., "accepts":[{ "network":"eip155:8453", "amount":"20000", ... }, ...]}
```

Pay with any x402 client. Base or Arc, with `@x402/fetch` and a viem account:

```js
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);  // holds a little USDC
const client = x402Client.fromConfig({
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],   // Arc: "eip155:5042"
  // Arc only: its USDC is not in @x402/evm's built-in asset list yet, so opt in (cap: $0.10 per call).
  // spendControls: { allowedAssets: [{ network: "eip155:5042", asset: "0x3600000000000000000000000000000000000000", maxAmountPerPayment: "100000" }] },
});
const pay = wrapFetchWithPayment(fetch, client);
const res = await pay("https://api.sitecheck-api.workers.dev/api/audit?url=example.com");
console.log(await res.json());
```

Solana, with `@x402/svm` and a `@solana/kit` signer:

```js
import { readFileSync } from "node:fs";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";

const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync("buyer.json", "utf8"))));
const client = new x402Client().register("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", new ExactSvmScheme(signer));
const pay = wrapFetchWithPayment(fetch, client);
console.log(await (await pay("https://api.sitecheck-api.workers.dev/api/audit?url=example.com")).json());
```

Every endpoint declares its input schema and an output example through the x402 Bazaar discovery extension, so agents can find and call it without reading docs.

### Demo agent

`scripts/demo-agent.mjs` discovers the API through `/.well-known/x402`, pays for one audit on the network you pick, and prints the result and the transaction link:

```bash
node scripts/demo-agent.mjs --network base     # or arc, solana
```

On the first run it creates a throwaway wallet in a git-ignored file (`.env.evm` for Base and Arc, `.env.solana` for Solana) and prints its address. **Fund it with about 0.10 USDC** on that network; one audit costs 0.02 USDC, and no ETH or SOL is needed. `--dry-run` stops before paying, and `--url` points it at another deployment.

## Design notes

- **Pay only for results.** The settlement runs after the handler. If a model or upstream fails, the handler returns an error status and the payment is **not settled**, so the buyer isn't charged. This holds on all three networks and is covered by the tests.
- **One route, several networks.** Each route lists one x402 `accepts` entry per configured network. Base and Solana settle through PayAI, and Arc through Circle's Facilitator Service with a Circle API key. Each facilitator client only reports the networks assigned to it (`lib/payments.js`).
- **Workers-safe x402 middleware.** A Worker can't await a promise created by another request, and the x402 middleware initialises lazily. Each request builds and initialises its own middleware until one has finished; that one is then reused (`lib/app.js`).
- **No keys in the repo.** Receiving addresses live in `wrangler.toml` `[vars]` (empty by default), and the Circle API key is a Worker secret. The helper scripts keep their throwaway wallets in git-ignored `.env.*` files.

## Run your own

```bash
npm install
npm test                    # no network needed: the facilitators are mocked
npx wrangler dev            # local
```

Deploy: set `account_id` and at least one receiving address in `wrangler.toml`, then:

```bash
npx wrangler secret put CIRCLE_API_KEY    # only if you set PAY_TO_ARC
npx wrangler deploy
```

| Variable | Network | Notes |
|---|---|---|
| `PAY_TO` | Base | EVM address |
| `PAY_TO_SOLANA` | Solana | wallet address; it must already have a USDC token account |
| `PAY_TO_ARC` | Arc | EVM address; also needs the `CIRCLE_API_KEY` secret ([Circle Console](https://console.circle.com), free) |
| `FACILITATOR_URL` | Base, Solana | default `https://facilitator.payai.network` |
| `FACILITATOR_URL_ARC` | Arc | default `https://api.circle.com/v1/facilitator/x402` |

Leave an address empty to switch that network off. `GET /health` shows which networks are active and why the others are not.

## License

MIT
