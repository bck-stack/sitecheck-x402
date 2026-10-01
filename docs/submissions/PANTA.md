# Panta API Sidetrack (Colosseum Crypto World's Fair)

Listing: <https://superteam.fun/earn/listing/panta-api-side-track/>. The prize pool is 5,000 USDG: 2,000 for first place, then 1,000 each for second, third and fourth. Submissions close **October 13, 2026, 06:59 UTC** (October 12, 23:59 PT), and winners are announced around October 27. The sidetrack doesn't replace the Colosseum submission: the project must also be submitted on colosseum.com (see [COLOSSEUM.md](COLOSSEUM.md)).

Judging criteria: meaningful Panta API integration, technical execution, product and UX, originality, impact potential, traction. The listing also asks for a working demo, a clear explanation of what was built and how Panta is integrated, and English. Support is in the `#dev-chat` channel of the Panta Discord (<https://discord.gg/M76nH6fUwc>).

## Before you submit (owner checklist)

1. **Get a Panta API key.** It is self-serve, and no price is published. The steps are in [docs/PANTA.md](../PANTA.md#getting-a-key): register at `POST /auth/register/` (or use **Try it** on the docs' Register page), then create a **`live`** key at `POST /account/keys/` with the access token. Copy the `secret` right away, because it is shown only once.
2. `npx wrangler secret put PANTA_API_KEY`, paste the key, then `npx wrangler deploy`.
3. Open `https://api.sitecheck-api.workers.dev/health` and check for `"markets": { "enabled": true, … }`. The landing page should now show "Prediction markets (Panta)".
4. Fund the Solana demo wallet (`.env.solana`, created by the demo scripts) with about 0.10 USDC. Run `node scripts/demo-markets.mjs --q bitcoin` (use another `--q` if nothing matches) and keep the Solscan links it prints.
5. Optional but recommended: ask Panta in `#dev-chat` to confirm that selling per-call, x402-paid access to Panta data and transactions fits their Terms (section 7(g); see [docs/PANTA.md](../PANTA.md#open-questions-and-uncertainties)). Their answer is also a good sign of traction.
6. Record the video (script below), upload it (Loom or YouTube, unlisted), and fill in the link.
7. Fill in the `[...]` placeholders and submit on Superteam Earn.

## Form answers

**Project Name**
SiteCheck

**Project Description**

SiteCheck is a live pay-per-call API for AI agents. Every call is paid on its own with x402, in USDC on Solana, Base or Arc: no account, no API key. For the Panta sidetrack we added a prediction-market toolset powered by the Panta API. With it, AI agents can buy market intelligence and ready-to-sign trade transactions per call.

*The problem.* Prediction-market prices are one of the best signals an agent can use when it researches a real-world event: the crowd's odds, with money behind them. But agents can't sign up for accounts, keep a partner API key for every service, or click through a trading UI. So today that signal, and the ability to act on it, stays with humans.

*What we built.* Five new routes on the same live Cloudflare Worker:
- `GET /api/markets?q=` ($0.002) searches Panta's USDC markets. It returns compact rows: the question, the YES/NO implied probability from live prices, volume, close and resolution times, and the resolution source.
- `GET /api/markets/brief?id=` ($0.01) gives one market's current odds, recent trading activity from Panta's trade tape, and a short neutral AI summary (Workers AI) of what the market asks, what resolves it and what the price implies. It never gives advice: advice-like wording falls back to a factual template, and every response says "Information only, not financial advice."
- `POST /api/markets/quote` ($0.005) returns Panta's primary-buy quote (expected shares, average price, fee) plus the price impact against the spot price.
- `POST /api/markets/build-buy` ($0.01) returns Panta's unsigned buy instructions and the same instructions compiled into an unsigned Solana v0 transaction, with the agent's wallet as the fee payer and only signer. The agent signs and broadcasts it itself. SiteCheck never signs, holds keys or custodies funds.
- `POST /api/markets/report` (free) forwards the broadcast signature to Panta's order-submit and trade-attribution endpoints, so the volume is confirmed and attributed.

An agent researching an event pays one cent and gets the crowd's odds. An agent that wants to act pays for an unsigned Panta transaction and signs it with its own wallet.

*How Panta is integrated.* SiteCheck uses seven Panta endpoints: `/markets/`, `/markets/{id}/`, `/markets/{id}/trades/`, `/primaryorderquote/`, `/primaryorderbuild/`, `/primaryordersubmit/` and `/trades/`. It follows Panta's custody model end to end: quote, build, the user signs, the user broadcasts, then confirm and attribute. Panta has no text search, so SiteCheck scans the catalog (cached for 45 s) and matches the words itself, then reads live prices for the results. Every response and the landing page carry "Powered by Panta", linked to panta.market.

*Engineering.* A payment settles only when the call succeeds, so a failed Panta call is never charged. Panta calls have timeouts, and each Panta error is mapped to a clear message. The build fails closed if Panta's order doesn't match the request, and only named fields pass through. 14 new tests (no network, with a mocked Panta API) check that every route offers payment on every network, that a failed Panta call never settles, that build-buy never returns anything signed, and that the disclaimer is always present. A demo agent script pays for search, brief and quote on Solana.

*Traction.* SiteCheck is live on mainnet with real settlements on Solana, Base and Arc, and an outside agent has paid for calls. The Panta routes are new.

Open source (MIT): https://github.com/bck-stack/sitecheck-x402

**Project Github Link**
https://github.com/bck-stack/sitecheck-x402

**Project Website**
https://api.sitecheck-api.workers.dev

**Project X Link**
https://x.com/offerastudio

**Link to your pitch deck or Loom/video presentation**
https://youtu.be/QvH-gbLQSr4

**Did you submit this project to the official Crypto World's Fair on Colosseum? (Yes/No)**
Yes

**Link to Colosseum project**
https://colosseum.com/arena/projects/sitecheck

**Link to your project's Colosseum profile** (optional)
`[Colosseum profile link]`

## How it meets the judging criteria

- **Panta API integration.** Seven endpoints across discovery, market data, primary buys and trade attribution. Panta's custody model and "Powered by Panta" attribution are followed as the docs and Terms describe. The integration notes are in [docs/PANTA.md](../PANTA.md).
- **Technical execution.** It runs on the same live Worker as the existing tools and inherits settle-only-on-success. It adds catalog caching, timeouts, fail-closed builds, and unsigned transactions compiled with `@solana/kit` and checked in tests. 33 tests pass, none of them touching the network.
- **Product and UX.** For an agent, it is one HTTP call per step, paid in the same request, with no signup. The responses are compact and self-describing: odds as probabilities, data freshness, the next step to take. A developer can copy the demo script and have an agent researching markets within minutes.
- **Originality.** Prediction markets as a paid data and execution layer for autonomous agents. The agent pays per call with x402 on the chain it already holds USDC on, and it trades without handing its keys to anyone.
- **Impact potential.** Any x402-capable agent can use Panta's markets as a research signal, and act on them with its own wallet. For Panta, every agent-built trade is attributed volume through a partner account.
- **Traction.** SiteCheck is live on mainnet with real settlements on Solana, Base and Arc, and an outside agent has paid for calls. The Panta routes are new.

---

## Demo video script (2 minutes)

Record at 1080p. Use a large terminal font (18 pt or more) and a clean browser profile. Before recording: deploy with the Panta key, fund the Solana demo wallet (about 0.10 USDC), and do one full dry run of `node scripts/demo-markets.mjs --q <topic>` with a topic that returns an open market with live prices. Keep its Solscan links open in tabs.

| Time | Shot | Voice-over |
|---|---|---|
| 0:00–0:10 | Title card: "SiteCheck × Panta: prediction markets for AI agents, paid per call". Then the landing page top. | "Agents can research the world, but prediction markets are built for people with accounts. SiteCheck turns Panta's markets into tools any agent can pay for per call." |
| 0:10–0:28 | Landing page: scroll to "Prediction markets (Panta)". Show the table and prices, the no-custody note and the "Powered by Panta" link. | "Search for a fifth of a cent, a market brief for a cent, a quote, and an unsigned buy transaction. Paid in USDC with x402 on Solana, Base or Arc. No account, no API key." |
| 0:28–0:45 | Terminal: `node scripts/demo-markets.mjs --q bitcoin`. Discovery and step 1: the market list with YES/NO odds. | "Here's an agent. It discovers the API, pays 0.002 USDC on Solana, and gets Panta's matching markets with the crowd's live odds." |
| 0:45–1:05 | Step 3 in the terminal: odds, recent activity, summary. Zoom on the summary. | "It picks an open market and pays one cent for a brief: the odds, recent trading, and a neutral summary of what the market asks and how it resolves. No advice, ever. Every answer says so." |
| 1:05–1:20 | Step 4 in the terminal: expected shares, fee, price impact. | "Before it acts, it pays half a cent for a quote from Panta's bonding curve: expected shares, fee and price impact." |
| 1:20–1:35 | Browser: open one of the printed Solscan links and show the USDC transfer. | "Each call was a real USDC payment on Solana, settled only after the tool succeeded. A failed call is never charged." |
| 1:35–1:52 | Terminal: the same command with `--build` (or the build-buy JSON), showing `signed: false` and the fee payer being the agent's wallet. | "To trade, build-buy returns Panta's transaction unsigned. The agent's own wallet signs and broadcasts it; SiteCheck never touches keys or funds. A free report call then sends the signature to Panta for attribution." |
| 1:52–2:00 | `npm test` passing, the GitHub repo, then the title card with the URL and "Powered by Panta". | "Open source and tested. SiteCheck: api.sitecheck-api.workers.dev. Powered by Panta." |

Shot list to prepare:
1. Title card (plain background): "SiteCheck × Panta: prediction markets for AI agents, paid per call".
2. Landing page: the top, then the "Prediction markets (Panta)" section with the table, the flow, the no-custody note and the "Powered by Panta" link.
3. Terminal run of `scripts/demo-markets.mjs` on Solana: discovery, search, brief and quote (record it once, cut into three parts).
4. Solscan: one settled payment from the run.
5. Terminal run with `--build`, showing the unsigned transaction summary. If Panta's build refuses the unfunded demo wallet, show the `build-buy` response from a funded wallet, or skip this shot and say it in the voice-over.
6. `npm test` output (33 passing) and the GitHub repo page.
