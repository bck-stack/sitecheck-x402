# SiteCheck: pay-per-call tools for AI agents (x402 on Base)

**Live:** https://api.sitecheck-api.workers.dev · listed on [x402scan](https://www.x402scan.com) · discovery: `/.well-known/x402`, `/openapi.json`

SiteCheck is a small API that AI agents can use **without an account or API key**. Every call is paid per request in **USDC on Base** with the [x402](https://x402.org) protocol. Call it, get a `402 Payment Required` with the price, sign the payment, get the result. It runs on Cloudflare Workers and Workers AI.

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

## Try it

```bash
curl -i "https://api.sitecheck-api.workers.dev/api/audit?url=example.com"
# HTTP/2 402, with the payment requirements (price, network eip155:8453, payTo)
```

Pay with any x402 client, e.g. `@x402/fetch`:

```js
import { wrapFetchWithPayment } from "@x402/fetch";
const pay = wrapFetchWithPayment(fetch, walletClient);   // viem wallet with USDC on Base
const res = await pay("https://api.sitecheck-api.workers.dev/api/audit?url=example.com");
console.log(await res.json());
```

Every endpoint declares its input schema and an output example through the x402 Bazaar discovery extension, so agents can find and call it without reading docs.

## Design notes

- **Pay only for results.** The settlement runs after the handler. If a model or upstream fails, the handler returns an error status and the payment is **not settled**, so the buyer isn't charged.
- **Workers-safe x402 middleware.** A Worker can't await a promise created by another request, and the x402 middleware initialises lazily. Each request builds its own middleware until one finishes initialising; that one is then reused (see `worker.js`).
- **No keys in the repo.** Configuration lives in `wrangler.toml` `[vars]` (receiving address, network, facilitator). The helper scripts keep their throwaway wallets in git-ignored `.env.*` files.
- Facilitator: [PayAI](https://facilitator.payai.network). Network: Base mainnet (`eip155:8453`).

## Run your own

```bash
npm install
npx wrangler dev            # local
npx wrangler deploy         # set account_id and PAY_TO in wrangler.toml first
```

## License

MIT
