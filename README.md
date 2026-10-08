# SiteCheck: pay-per-call tools for AI agents (x402 on Base, Solana and Arc)

**Live:** https://api.sitecheck-api.workers.dev · listed on [x402scan](https://www.x402scan.com) · discovery: `/.well-known/x402`, `/openapi.json`

SiteCheck is a small API that AI agents can use **without an account or API key**: 29 pay-per-call tools in all. Besides its AI and web tools (including a [web page to Markdown reader](#web-documents-e-mail-domain-and-solana-data)), it sells PDF to text, translation, tech stack detection, sitemap URLs, exchange rates, e-mail, domain and Solana token and wallet data, [business and compliance data](#business-and-compliance-data) (EU VAT, IBAN, LEI, US recalls, OSHA/EPA enforcement, UK insolvency notices), prediction-market data and unsigned trade transactions [powered by Panta](#prediction-markets-panta). Every call is paid per request in **USDC** with the [x402](https://x402.org) protocol, on **Base**, **Solana** or **Arc** (Circle's L1), whichever the buyer holds USDC on. Call it, get a `402 Payment Required` listing the price on each network, sign the payment and get the result. It runs on Cloudflare Workers and Workers AI.

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
| `GET /api/vat?number=` | $0.002 | EU VAT number check: format and checksum locally, then the official VIES service (27 EU states + Northern Ireland) |
| `GET /api/iban?iban=` | $0.001 | IBAN validation with no network call: registry structure and length, mod-97, national check digits, bank/branch/account split; `ibans=` for up to 50 |
| `GET /api/lei?q=` | $0.005 | GLEIF lookup by LEI or company name: status, registration, parents, children, one-line `kycSummary` |
| `GET /api/recalls?q=&source=&since=&classification=&limit=` | $0.003 | US product recalls from openFDA and CPSC in one schema, with a high/medium/low severity |
| `GET /api/violations?company=&state=&since=&minPenalty=&source=&limit=` | $0.005 | US enforcement cases: OSHA (DOL API, needs a key on the deployment) and EPA ECHO, with official record links |
| `GET /api/uk-insolvency?since=&q=&postcode=&type=&limit=` | $0.003 | UK company insolvency notices from The Gazette (our nightly cache of the last 8 days), optional Companies House enrichment |
| `GET /api/read?url=&format=&maxChars=&links=` | $0.002 | One web page as clean Markdown or text for an LLM: main content only, title, description, author, date, language, canonical; robots.txt respected |
| `GET /api/email-check?email=` | $0.001 | E-mail pre-check without SMTP: syntax, mail DNS, disposable domain, role account, free provider, typo suggestion; `emails=` for up to 50 |
| `GET /api/domain?domain=` | $0.002 | RDAP (WHOIS successor) and DNS: registered or available, registrar, created/expiry dates, status, DNSSEC, name servers, IPs, MX |
| `GET /api/solana/token?address=` | $0.002 | Solana token check: price, market cap, liquidity, holders, 24h trading, organic score, top-holder share, on-chain mint/freeze authority and Token-2022 extensions, red flags |
| `GET /api/solana/trending?mode=&interval=&minLiquidityUsd=` | $0.003 | Trending, new, top-traded or top-organic Solana tokens with the same fields and flags |
| `GET /api/solana/wallet?address=` | $0.003 | Solana wallet holdings: SOL and every token with symbol, USD price and value, total in USD |
| `GET /api/tech?url=` | $0.003 | Website technology detection (CMS, e-commerce, analytics, CDN, hosting, chat, payments, e-mail provider) with version, confidence and evidence |
| `POST /api/pdf` | $0.003 | PDF to text by URL or base64 (up to 15 MB), page by page, with title, author and dates; text PDFs only |
| `GET /api/sitemap?url=&pathPrefix=&since=` | $0.002 | Every URL in a site's XML sitemaps with lastmod, newest first |
| `GET /api/fx?from=&to=&amount=&date=` | $0.001 | ECB exchange rates (latest, a past date or a time series) with amount conversion |
| `POST /api/translate` | $0.002 | Translation with Llama 3.1 8B, up to 6,000 characters, formatting kept |

## Prediction markets (Panta)

Agents can buy market intelligence and ready-to-sign trade transactions per call, with no account and no API key. An agent researching an event pays a fraction of a cent to find the markets and one cent for a market's odds and a neutral brief. An agent that wants to act pays for an unsigned [Panta](https://panta.market) buy transaction and signs it with its own wallet. Panta runs USDC prediction markets on Solana.

| Endpoint | Price | What it does |
|---|---|---|
| `GET /api/markets?q=&status=&category=&limit=` | $0.002 | Searches Panta's markets. Compact rows: id, question, YES/NO prices and implied probabilities, volume, close and resolution times, resolution source |
| `GET /api/markets/brief?id=` | $0.01 | One market: current odds, recent trading activity and a short neutral AI summary of what it asks, what resolves it and what the price implies |
| `POST /api/markets/quote` | $0.005 | Body `{ id, side: "yes"\|"no", amountUsdc, wallet }`. Panta's quote: expected shares, average price, fee, and price impact against the spot price |
| `POST /api/markets/build-buy` | $0.01 | Same body, plus an optional `maxSlippageBps`. Returns the **unsigned** transaction (Solana v0, base64) and Panta's instructions for the agent to sign and broadcast itself, plus the fields for the trade report |
| `POST /api/markets/report` | free | After broadcasting, send `{ signature, orderId, quoteId, id, wallet }`. SiteCheck forwards it to Panta, which confirms and attributes the trade |

- **No custody.** SiteCheck never signs, holds keys or custodies funds. `build-buy` hands back an unsigned transaction whose only signer is the agent's wallet.
- **Information only, not financial advice.** Every response says so (`disclaimer`), and the brief never recommends a trade. If the model's text reads like advice, a factual template is returned instead.
- **Powered by Panta.** Every response carries `poweredBy: { text: "Powered by Panta", url: "https://panta.market" }`, as Panta's Terms of Use require.
- **Pay only for results**, as with every tool: if Panta refuses or fails, the call returns an error and nothing is settled. The catalog is cached for 45 seconds and prices for 15 seconds, and responses say how old their data is.
- The tools are on only when the `PANTA_API_KEY` secret is set. Otherwise they are hidden, and `GET /health` says why. Endpoints, shapes, attribution and open questions: [docs/PANTA.md](docs/PANTA.md).

```bash
node scripts/demo-markets.mjs --q bitcoin            # search, brief and quote, paid on Solana (~0.017 USDC)
node scripts/demo-markets.mjs --q bitcoin --build    # also builds the unsigned transaction (+0.01); never signs or sends it
```

## Web, documents, e-mail, domain and Solana data

| Tool | Source | Notes |
|---|---|---|
| `/api/read` | The page itself, fetched once with the `SiteCheckReader` User-Agent | `robots.txt` is respected (a disallowed page answers 403 and is not charged). No JavaScript is run, so pages that only render in the browser come back empty (422, not charged). PDFs and other binary files answer 415. The content belongs to its publisher. |
| `/api/email-check` | DNS over HTTPS (Cloudflare, Google) and the [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) list (CC0) | No SMTP connection is made: `unknown` means nothing is wrong with the address or its domain, not that the mailbox exists. |
| `/api/domain` | The [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json) and each registry's RDAP server; DNS over HTTPS | `available` means the registry has no record; premium or reserved names can still be unavailable to buy. TLDs without RDAP are inferred from DNS. |
| `/api/solana/token`, `/api/solana/trending`, `/api/solana/wallet` | [Jupiter](https://jup.ag) token, price and holdings APIs, Solana mainnet JSON-RPC (mint account), [GeckoTerminal](https://www.geckoterminal.com) for pools (best effort) | Information only, not financial advice. Nothing is signed or sent. On-chain mint and freeze authority win over the API's audit when both are available. |
| `/api/tech` | The site's home page, headers, cookies and DNS (MX, TXT); 231 own fingerprints (MIT, not derived from Wappalyzer) | No JavaScript is run; a site behind a bot challenge returns what its headers and DNS show. |
| `/api/pdf` | The PDF's text layer, read with [unpdf](https://github.com/unjs/unpdf) (PDF.js) | No OCR: a scanned PDF answers 422 and is not charged. |
| `/api/sitemap` | The site's `robots.txt` and XML sitemaps | Indexes are followed up to 25 child sitemaps per call. |
| `/api/fx` | European Central Bank reference rates via [Frankfurter](https://frankfurter.dev) | Published on working days around 16:00 CET; weekends return the last published day. |
| `/api/translate` | Workers AI `@cf/meta/llama-3.1-8b-instruct-fast` | Machine translation: review important texts. |

## Business and compliance data

Six tools for an agent that has to check a counterparty before it trades with it. All of them read free official sources (or our own cache of one), need no key from the caller, and follow the same rule as every route here: **a call that fails (bad input, upstream down, timeout) returns 4xx/5xx and is not settled, so the buyer is not charged.**

| Tool | Source | Terms |
|---|---|---|
| `/api/vat` | European Commission [VIES](https://ec.europa.eu/taxation_customs/vies/) REST API | Public service of the Commission. A member state that is down gives HTTP 503 with a `viesStatus` such as `MS_UNAVAILABLE`, so an unknown answer is never reported as "invalid". Some states (e.g. DE, ES) confirm validity but do not disclose name and address: those fields are `null`. |
| `/api/iban` | Computed locally from the SWIFT IBAN registry structure (release 101) | No network, no bank-name or BIC lookup (no open dataset is bundled; the response says `bankLookup: false`). National check digits are applied only where a public algorithm exists (FR, ES, IT, BE, NL for ABNA/INGB/RABO, NO, FI, PL, PT, RS, ME, MK, XK, SI); other countries report `not-available`. Germany has no general national algorithm. |
| `/api/lei` | [GLEIF](https://www.gleif.org/en/lei-data/gleif-api) Global LEI Index | CC0 public domain. No key. |
| `/api/recalls` | [openFDA](https://open.fda.gov/terms/) enforcement reports (food, drug, device) and the CPSC [SaferProducts.gov](https://www.saferproducts.gov/) Recall API | openFDA data is public domain under its terms of use (not for medical decisions). CPSC does not classify recalls: its severity is derived from the hazard text, FDA Class I/II/III maps to high/medium/low. |
| `/api/violations` | US Department of Labor [Data API v4](https://dataportal.dol.gov/) (OSHA) and [EPA ECHO](https://echo.epa.gov/tools/web-services) | US government works. OSHA needs the optional `DOL_API_KEY` secret: without it the route returns EPA only and says OSHA is off. Records are matched by name and show inspections and cases, not guilt. |
| `/api/uk-insolvency` | [The Gazette](https://www.thegazette.co.uk), through our own nightly cache (`gazette-cache.sitecheck-api.workers.dev`, last 8 UK days). The Gazette is never called directly. | [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Answers carry the cache's `dataTimestamp` and any `missingDays`. Optional [Companies House](https://developer.company-information.service.gov.uk/) enrichment (status, incorporation date, SIC codes, address; at most 10 rows per call) when `COMPANIES_HOUSE_API_KEY` is set. |

Workers limits are respected: every upstream call has a timeout (at most 10 s) and a `SiteCheck/1.x` User-Agent, every tool stays well under 50 subrequests, and nothing large is parsed per request (the Gazette text is scanned and only matching notices are parsed). Stable upstream answers are cached with the Cache API where it works.

```bash
curl -s "https://api.sitecheck-api.workers.dev/api/vat?number=DE811907980"        # 402 first: pay with any x402 client
```

## MCP server

`https://api.sitecheck-api.workers.dev/mcp` is a remote MCP server (Streamable HTTP, stateless, JSON answers). Every paid endpoint is an MCP tool with the same input schema (`read`, `pdf`, `tech`, `email_check`, `domain`, `solana_token`, `vat`, `lei`, ...), and the same price.

Payment uses the x402 MCP transport: a `tools/call` without payment returns `isError` with the x402 `PaymentRequired` object in `structuredContent`; the client signs one option and repeats the call with the `PaymentPayload` in `params._meta["x402/payment"]`; the answer carries the settlement in `result._meta["x402/payment-response"]`. A tool call that fails is not settled. Each call is replayed inside the Worker against the matching `/api` route, so MCP and HTTP buyers go through the same payment checks.

```ts
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = createx402MCPClient({
  name: "my-agent", version: "1.0.0",
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }], // a viem account holding USDC on Base
  autoPayment: true,
});
await client.connect(new StreamableHTTPClientTransport(new URL("https://api.sitecheck-api.workers.dev/mcp")));
const page = await client.callTool("read", { url: "https://docs.x402.org/introduction" }); // pays $0.002
```

MCP clients without x402 support (for example a plain remote connector) can list the tools and see each price, but a call returns the payment requirements instead of a result.

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
- **One route, several networks.** Each route lists one x402 `accepts` entry per configured network. Base and Solana settle through PayAI. Arc settles through Circle's Facilitator Service on its keyless trial: each request carries a seller proof signed by the Arc receiving wallet's key (see below). Each facilitator client only reports the networks assigned to it (`lib/payments.js`).
- **Workers-safe x402 middleware.** A Worker can't await a promise created by another request, and the x402 middleware initialises lazily. Each request builds and initialises its own middleware until one has finished; that one is then reused (`lib/app.js`).
- **No keys in the repo.** Receiving addresses live in `wrangler.toml` `[vars]` (empty by default). The Arc seller key (or, as a fallback, the Circle API key) is a Worker secret. The helper scripts keep their wallets in git-ignored `.env.*` files.

### Arc: Circle's keyless trial and a hot wallet

Circle's Facilitator Service normally needs an API key, and on mainnet that needs a Circle account with a credit card on file. SiteCheck uses Circle's [keyless trial](https://developers.circle.com/facilitator-service/keyless-trial) instead. Every `/verify` and `/settle` request carries a `Facilitator-Seller-Proof` header: an EIP-712 signature by the key that controls Arc's `payTo`, bound to the route, the exact request body and a fresh nonce (`lib/sellerProof.js`, `lib/circle.js`).

The trade-off: that key has to live in the Worker, as the secret `ARC_SELLER_KEY`. So Arc's `payTo` is a dedicated hot wallet that only receives payments. The owner sweeps it to a cold wallet regularly (`scripts/sweep-arc.mjs`), so a leaked key would expose at most what came in since the last sweep. The trial allowance is also limited, and Circle doesn't publish it. When it runs out, Circle answers `403 registration_required`. The payment is not settled and the buyer is not charged, the Worker logs it, and `GET /health` shows `arc.trialExhausted: true`. From then on, Arc needs a Circle API key or has to be switched off. Details: [docs/NETWORKS.md](docs/NETWORKS.md#keyless-trial-seller-proofs).

## Run your own

```bash
npm install
npm test                    # no network needed: the facilitators and Panta are mocked
npx wrangler dev            # local
```

Deploy: set `account_id` and at least one receiving address in `wrangler.toml` (or pass it with `--var`). For Arc, create the hot wallet and store its key first:

```bash
node scripts/new-arc-wallet.mjs            # Arc only: prints the new address; the key goes to .env.arc-seller
npx wrangler secret put ARC_SELLER_KEY     # paste the key from .env.arc-seller
npx wrangler secret put PANTA_API_KEY      # optional: a pk_live_... key switches the prediction-market tools on
npx wrangler secret put DOL_API_KEY        # optional: switches OSHA on in /api/violations
npx wrangler secret put COMPANIES_HOUSE_API_KEY   # optional: enriches /api/uk-insolvency rows
npx wrangler deploy
node scripts/sweep-arc.mjs --to 0xYourColdWallet          # later, regularly: shows what it would send
node scripts/sweep-arc.mjs --to 0xYourColdWallet --yes    # sends it
```

| Variable | Network | Notes |
|---|---|---|
| `PAY_TO` | Base | EVM address |
| `PAY_TO_SOLANA` | Solana | wallet address; it must already have a USDC token account |
| `ARC_SELLER_KEY` (secret) | Arc | private key of the dedicated Arc receiving wallet; switches Arc on and sets its `payTo` |
| `PAY_TO_ARC` | Arc | optional with `ARC_SELLER_KEY` (if set, it must equal the key's address); without a seller key, the Arc address to use with `CIRCLE_API_KEY` |
| `CIRCLE_API_KEY` (secret) | Arc | fallback only, used when `ARC_SELLER_KEY` is not set |
| `FACILITATOR_URL` | Base, Solana | default `https://facilitator.payai.network` |
| `FACILITATOR_URL_ARC` | Arc | default `https://api.circle.com/v1/facilitator/x402` |
| `PANTA_API_KEY` (secret) | all | switches the prediction-market tools on: `npx wrangler secret put PANTA_API_KEY` (see [docs/PANTA.md](docs/PANTA.md#getting-a-key)) |
| `PANTA_BASE_URL` | all | default `https://live-api.panta.market/api/v1` |
| `DOL_API_KEY` (secret) | all | optional: switches OSHA on in `/api/violations`: `npx wrangler secret put DOL_API_KEY`. Without it the route is EPA only |
| `COMPANIES_HOUSE_API_KEY` (secret) | all | optional: Companies House enrichment in `/api/uk-insolvency`: `npx wrangler secret put COMPANIES_HOUSE_API_KEY` |

Leave an address empty to switch that network off. `GET /health` shows which networks are active and why the others are not, and whether the Panta tools are on. For Arc it also shows the auth mode, the receiving address and the trial status.

## License

MIT

## Mainnet transactions

Real x402 settlements on all three networks:

- Solana (our test): https://solscan.io/tx/4DQcTjw791d83iUFU7NBbyi3JZxXsvHbNHWgcXb9eeVT4tqReDV4ZFqYanUpJXnGP2ogucsWHqehioJd6Dq1ghDJ
- Base (our test): https://basescan.org/tx/0xf4e4a1aeeff698706e49cd921321cda9dba79babefd00b624bdf836fda57beb1
- Arc (our test): https://explorer.arc.io/tx/0xb6abceb6108099730c31b00f9140288585a869029bc5c922b88f0df5e8289476
- Base, paid by an outside AI agent we don't control (one of its 12 paid calls so far): https://basescan.org/tx/0x9e37d0287f04f7c1f89f159f839c0f391230dab6c21aeead58d6a29588239ea9
- Base, paid by a second outside wallet (6 Oct 2026): https://basescan.org/tx/0x9d5f1cae2c5016f165eead7dc56f51a3d74a1ea90a06270d4b0ca8bf97d8d211
