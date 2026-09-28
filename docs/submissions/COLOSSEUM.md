# Colosseum: Crypto World's Fair

Hackathon: <https://colosseum.com/worldsfair>. The contest runs September 14 – **October 12, 2026, 11:59pm PT**, and winners are announced by December 5, 2026. Each team member registers on colosseum.com, and the team leader uploads the submission. A team can have one submission at a time.

Tracks to enter: **Solana** ($100,000 across 10 projects), **Base** ($25,000 across 5 projects), and the **Public Goods Award** ($5,000). Pick every one of these the form allows. The judging criteria from the official rules are functionality, potential impact, novelty, UX, open source and composability, and business plan. The notes at the end map SiteCheck to each one.

Fill in the `[...]` placeholders before submitting.

## Project name
SiteCheck

## One-liner
Pay-per-call AI and web tools for AI agents: no accounts, no API keys, paid per request in USDC with x402 on Solana, Base or Arc.

## Problem
AI agents are starting to do real work: research, lead lists, website checks, content. To do it they need tools, and most tools are sold the human way: sign up, verify an email, add a card, pick a monthly plan, copy an API key. An agent can't do any of that on its own, so every tool it uses has to be set up by a person in advance. That limits agents to whatever their developer pre-wired, and it forces small tools into subscriptions when agents only need a few calls.

## Solution
SiteCheck is a live API with eight tools priced per call, from $0.001 to $0.02: website accessibility audits (WCAG 2.2, relevant under the European Accessibility Act), company contact lookup from a domain, a Hacker News jobs search, LLM chat, image generation, speech-to-text, text-to-speech and embeddings.

Any agent can use it with no setup:
1. It calls an endpoint and gets `402 Payment Required`, listing the USDC price on Solana, Base and Arc.
2. Its x402 client signs a payment on the network it holds USDC on.
3. It sends the request again and gets the result. Payment settles only when the tool succeeds; a failed call is never charged.

Agents find the API on their own through `/.well-known/x402`, an OpenAPI document with prices, and x402 Bazaar schemas in every 402. It is listed on x402scan.

## Why crypto
- **x402** turns payment into part of the HTTP request, so an agent can pay for a call the way it makes a call. No account, no key, no invoice.
- **USDC** gives a stable, dollar-denominated price that works for amounts as small as a tenth of a cent. No card network can charge $0.001.
- **No accounts for agents:** the wallet is the identity. Any agent with a few cents of USDC on Solana, Base or Arc can use every tool right away, and the seller never stores user data or credentials.
- Settlement is on chain and verifiable: every paid call has a transaction hash.

## Business model
- Each call is priced above what it costs to serve. The costs are Cloudflare Workers and Workers AI inference, plus the upstream fetches for the web tools. The margin is per call, and there are no subscriptions to sell or churn to manage.
- Customers are teams building agents (B2B agent tooling). They get tools their agents can buy per use, without a procurement process or a new vendor account for every capability.
- Growth comes from adding tools that agents need and that cost little to run, and from being listed wherever agents discover x402 services (x402scan, Bazaar-style discovery, marketplaces).
- The code is open source (MIT). The business is the hosted, maintained, always-on endpoint and its reputation, not the code.

## Traction to date (honest)
- Live since September 2026 at https://api.sitecheck-api.workers.dev (first on Base).
- Listed on x402scan: `[x402scan listing link]`.
- Open source: https://github.com/bck-stack/sitecheck-x402 (MIT).
- **No paying customers yet.** Any payments so far are our own test purchases.

## What was built during the hackathon
- Solana (`solana:5eykt4…`, USDC through the PayAI facilitator) and Arc (`eip155:5042`, USDC through Circle's Facilitator Service) added next to Base on all eight endpoints. Each network is switched on by config.
- Discovery (`/.well-known/x402`, `openapi.json`) and a landing page listing all three networks, with copy-paste client code and a live 402 demo.
- A demo agent (`scripts/demo-agent.mjs`) that discovers the API, pays on the network you choose and prints the transaction.
- Tests (no network, mocked facilitators) proving that each route offers every configured network and that a failed call never settles.

## Roadmap
- **Now:** Solana and Arc live on mainnet next to Base; the demo video; this submission.
- **Next:** more low-cost tools agents ask for; an MCP server so MCP-based agents can use the tools directly; browser-based accessibility checks (contrast and keyboard) for the audit.
- **Later:** variable pricing for calls whose cost depends on input size (x402 `upto`), and sub-cent pricing through batched settlement where the networks support it.

## Tracks
- **Solana:** every endpoint accepts USDC on Solana mainnet through the x402 `exact` SVM scheme. The facilitator pays fees, so the agent needs only USDC.
- **Base:** Base USDC was the first payment network and is still the default option.
- **Public Goods Award:** the whole service is MIT-licensed and small enough to read in an afternoon. It shows a working, tested pattern that anyone can copy: one x402 API accepting payment on three chains, per-request Workers-safe middleware, settle-only-on-success. The accessibility audit helps site owners find the WCAG issues that matter under the European Accessibility Act.

## Links
- Live API and landing page: https://api.sitecheck-api.workers.dev
- Repo: https://github.com/bck-stack/sitecheck-x402
- Demo video: `[link]`
- Example transactions: Solana `[solscan link]`, Base `[basescan link]`, Arc `[explorer.arc.io link]`
- Team: `[name]`, founder, Offera Studio Ltd (UK). GitHub: https://github.com/bck-stack · X: `[handle]`

## How it meets the judging criteria
- **Functionality:** live on mainnet, eight working tools, three payment networks, automated tests, demo agent.
- **Potential impact:** any agent with USDC can use it without human setup, and the pattern works for any API.
- **Novelty:** one endpoint that takes USDC on Solana, Base and Arc and lets the agent choose, with a guarantee that failed calls are free.
- **UX:** for the agent, a single retry with a signed payment. For a developer, about ten lines of client code. No gas token is needed on any network.
- **Open source:** MIT. Built on the standard x402 packages and public facilitators, so it composes with any x402 client or discovery service.
- **Business plan:** per-call margins over infrastructure costs, sold to teams building agents.

---

## Demo video script (3 minutes)

Record at 1080p. Use a large terminal font (18 pt or more) and a clean browser profile. Before recording, fund the demo wallets (about 0.10 USDC each on Solana, Base and Arc) and do one dry run per network, so every command finishes quickly on camera.

| Time | Shot | Voice-over |
|---|---|---|
| 0:00–0:15 | Title card: "SiteCheck: tools AI agents can pay for per call". Then the landing page. | "AI agents can call APIs, but they can't sign up, add a card or manage API keys. SiteCheck lets an agent pay for each call with USDC, with no account at all." |
| 0:15–0:40 | Landing page: scroll the tools table and prices, then the Networks table with Solana, Base and Arc. | "Eight tools, from a tenth of a cent to two cents per call. Each call can be paid on Solana, Base or Arc, whichever network the agent holds USDC on." |
| 0:40–0:55 | Click "Run it from this page". The decoded 402 appears with three `accepts` entries. | "Calling without paying returns HTTP 402. The answer lists the exact price and receiving address on each network. This is the x402 standard." |
| 0:55–1:25 | Terminal: `node scripts/demo-agent.mjs --network solana`. Show discovery, balance, payment, the audit result, and the Solscan link. Open the link in the browser. | "Here is an agent. It finds the API through its well-known discovery file, checks its USDC, and pays two cents on Solana. It gets the audit back, with the accessibility score and issues, and here is the settled transaction on Solana." |
| 1:25–1:50 | Terminal: `--network base`. Open the Basescan link. | "Same agent, same call, paid on Base. The agent only signed a USDC authorization; it needed no ETH." |
| 1:50–2:15 | Terminal: `--network arc`. Open the Arc explorer link. | "And on Arc, Circle's stablecoin chain, settled by Circle's facilitator. Arc has instant finality, so the payment is final before the result comes back." |
| 2:15–2:30 | Editor: `lib/routes.js` (the `accepts` per network), then the terminal running `npm test`, all passing. | "Under the hood, each route lists one payment option per network. Payment settles only after the tool succeeds, and the tests check that a failed call is never charged." |
| 2:30–2:45 | x402scan page listing SiteCheck. | "It's listed on x402scan, so agents can discover it without us." |
| 2:45–3:00 | GitHub repo page, then the title card with the URL. | "It's open source under MIT. The business is simple: a margin on every call, sold to teams building agents. SiteCheck: api.sitecheck-api.workers.dev." |

Shot list to prepare:
1. Title card (text on a plain background).
2. Landing page at the top, tools table, networks table, the "Try it" result.
3. Terminal runs: Solana, Base, Arc (record each separately and cut together).
4. Explorer pages for the three transactions.
5. Editor view of `lib/routes.js` and `npm test` output.
6. x402scan listing page.
7. GitHub repo page.
