# Panta API integration

SiteCheck's prediction-market tools (`/api/markets*`) are built on the [Panta API](https://docs.panta.market/). Panta runs binary YES/NO prediction markets in USDC on Solana. Its API lists markets, quotes and builds **unsigned** transactions, and verifies and attributes trades. It never holds user keys, and SiteCheck doesn't either.

This page records what the integration is based on: the endpoints, the request and response shapes, the attribution rules, how SiteCheck uses them, and what the docs leave open. Everything was read on **2026-09-30** from:

- the docs at <https://docs.panta.market/>, including the machine-readable index [`llms.txt`](https://docs.panta.market/llms.txt), the full text [`llms-full.txt`](https://docs.panta.market/llms-full.txt) and every page as `.md`;
- the [Terms of Use](https://docs.panta.market/guides/terms-of-use) (effective 2026-09-07);
- the playground repo [Kaito-HQ/panta-api-playground](https://github.com/Kaito-HQ/panta-api-playground) at commit `a92b0db` (`src/lib/api.ts`, `types.ts`, `solana.ts`, `components/*Flow.tsx`, `MarketsPanel.tsx`, `CONTRIBUTING.md`);
- the live API itself, called without a key only to confirm the error envelope and the trailing-slash rule.

## Basics

| | |
|---|---|
| Base URL | `https://live-api.panta.market/api/v1` (the playground's `.env.example` also names `https://staging-api.panta.market/api/v1`) |
| Auth | `X-Api-Key: pk_live_…` or `pk_test_…` (both are accepted on the public API), **or** `Authorization: Bearer <access JWT>`. A key in the query string is rejected with `401`. |
| Paths | Trailing slashes are required. Checked live: `GET /markets` answers `301` to `/markets/`. A POST that gets redirected would lose its body, so every SiteCheck call ends with `/`. |
| Content type | `application/json` on POST |
| Optional headers | `X-Request-Id` (echoed back), `X-User-Id` (attribution id, which defaults to the authenticated account) |
| Response headers | `X-Request-Id`, `X-Powered-By: Panta` on 2xx, `X-RateLimit-Limit` / `-Remaining` / `-Reset`, `Retry-After` on 429 |
| Amounts | Primary buys use human decimal strings (`"20.00"`). Market creation uses base units (`"50000000"` = 50 USDC). |
| Network | Solana. USDC markets. The integrator broadcasts transactions on its own RPC; Panta does not broadcast. |

Checked live without a key: `GET /markets/?limit=1` returns `401 {"code":"UNAUTHORIZED","message":"authentication required…"}` with `content-type: application/json`. An unknown path (`/health/`) returns an **HTML** 404, so the client must not assume every error body is JSON.

### Getting a key

1. `POST /auth/register/` with `{ "email", "password" (8–128), "name"? }`. The call is public. It returns `201 { userId, email, name, access, refresh }` (JWTs). A duplicate email returns `409 EMAIL_TAKEN`.
2. `POST /account/keys/` with `Authorization: Bearer <access>` and `{ "env": "live" | "test", "name"?, "revokeOthers"? }`. It returns `201 { id, name, prefix, env, status, secret, createdAt, revokedAt }`. **`secret` is shown only once.**
3. Check the key with `GET /whoami/` (an alias of `GET /account/`), sending `X-Api-Key: <secret>`.

The docs' interactive playground (the **Try it** button on the Register and Create API key pages) does the same against production. Neither the docs nor the Terms list a price for API access. Signing up is self-serve and asks for no payment details. Section 12 of the Terms says Panta "may offer free and paid API access" and may introduce fees later with notice.

### Errors

Every error is JSON `{ "code", "message", "field"?, "fields"? }` (except the HTML 404 above). Switch on `code`; the HTTP status gives the class of failure.

| HTTP | Meaning | Codes seen on the endpoints we use |
|---|---|---|
| 400 | validation or business rule | `INVALID_MARKET_PARAMS`, `AMOUNT_TOO_SMALL`, `MARKET_NOT_IN_PRIMARY`, `QUOTE_EXPIRED`, `QUOTE_STALE`, `TX_FAILED`, `TX_MISMATCH`, `TX_FEE_MISMATCH` |
| 401 | missing or invalid credentials, or a wallet that doesn't match the bound session | `UNAUTHORIZED` |
| 403 | authenticated but not allowed | `FORBIDDEN` |
| 404 | market or transaction not found | `MARKET_NOT_FOUND`, `TX_NOT_FOUND` |
| 429 | rate limited (honour `Retry-After`) | `RATE_LIMITED` |
| 500 | internal | `INTERNAL_ERROR` |

Default rate limits, per account: `read` 120 per 60 s (catalog, account), `positions` 60, `quote` 30, `build` 20, `register` 40 (register, trade report, submit, auth), `upload` 10.

Session lifetimes: primary quote (`quoteId`) about 90 s, primary order (`orderId`) about 120 s, build blockhash about 60 s, create session about 5 min.

## Endpoints SiteCheck uses

### `GET /markets/`: catalog list

Query parameters: `category` (from `GET /categories/`: `sports`, `crypto`, `politics`, `entertainment`, `finance`, `science`, `world`, `other`), `status` (the market **phase**: `primary` | `secondary` | `resolved` | `cancelled`), `createdBy=me`, `cursor` (from `nextCursor`), `limit` (default 20, max 50).

```json
{
  "items": [{
    "marketId": "…", "category": "crypto", "title": "ETH above 5k?", "description": "…",
    "images": ["https://…"], "phase": "primary", "marketType": "standard",
    "startTime": 1767225600, "endTime": 1798761599, "resolutionTime": 1798765199,
    "region": "Global", "resolved": false, "status": "open", "volumeUsdc": "1200.00",
    "campaignId": null, "createdByPartner": true,
    "yesPrice": null, "noPrice": null, "primaryYesPrice": null, "primaryNoPrice": null,
    "secondaryYesPrice": null, "secondaryNoPrice": null
  }],
  "nextCursor": "…"
}
```

List rows come from Panta's registry and are **not** priced ("do not live-RPC for prices"). There is **no text-search parameter**.

### `GET /markets/{marketId}/`: one market with spot prices

It has the same shape as a list row, with `yesPrice` / `noPrice` / `primary*` / `secondary*` filled from on-chain state "when RPC is available", so they can still be `null`. Example prices: `"yesPrice": "0.52", "noPrice": "0.48"`. The playground reads `yesPrice ?? primaryYesPrice`. Errors: `UNAUTHORIZED`, `RATE_LIMITED`, `MARKET_NOT_FOUND`.

### `GET /markets/{marketId}/trades/?limit=`: public trade tape

`limit` defaults to 50, max 200. The answer is `{ marketId, items: [{ id, marketId, wallet, isPrimary, yesAmount, noAmount, feePaid, blockTime, signature, quoteAsset }] }`. This is the public tape, not partner attribution. The rows have no per-trade price.

### `POST /primaryorderquote/`: quote a primary buy

Body: `{ wallet, marketId, side: "yes"|"no", amountUsdc: "20.00", userId? }`. Answer:

```json
{ "quoteId": "qt_…", "marketId": "…", "side": "yes", "amountUsdc": "20.00", "shares": "38.42",
  "avgPrice": "0.520800", "feeUsdc": "0.40", "expiresAt": "2026-09-04T16:27:00.000000Z", "blockhashExpiryHintSec": 60 }
```

Errors: `INVALID_MARKET_PARAMS`, `MARKET_NOT_FOUND`, `MARKET_NOT_IN_PRIMARY`, `AMOUNT_TOO_SMALL`, `RATE_LIMITED`. Primary buys pay an on-chain fee of about `amount × primaryFeeBps / 10 000`, where `primaryFeeBps` is commonly 200 (2%).

### `POST /primaryorderbuild/`: unsigned instructions

Body: `{ quoteId, wallet (must match the quote), userId?, maxSlippageBps? (default 100, max 5000) }`. Answer:

```json
{
  "orderId": "ord_…", "quoteId": "qt_…", "wallet": "…", "marketId": "…", "side": "yes",
  "amountUsdc": "20.00", "expectedShares": "38.40", "feeUsdc": "0.40", "status": "built",
  "instructions": [{ "programId": "…", "data": "<base64>", "accounts": [{ "pubkey": "…", "isSigner": true, "isWritable": true }] }],
  "derived": { "event": "…", "vaultAuthority": "…" },
  "recentBlockhash": "…", "lastValidBlockHeight": 123, "expiresAt": "…", "blockhashExpiryHintSec": 60
}
```

It returns **instructions, not a transaction**. The integrator compiles a versioned transaction from `instructions` and `recentBlockhash`. The playground uses web3.js `TransactionMessage({ payerKey: wallet, recentBlockhash, instructions }).compileToV0Message()`. The wallet signs, and the integrator broadcasts. If the curve moved more than `maxSlippageBps` since the quote, the build fails with `QUOTE_STALE` and needs a new quote. When `userId` / `X-User-Id` is present, the build "may include an SPL Memo instruction" for attribution. Errors: `QUOTE_EXPIRED`, `QUOTE_STALE`, `UNAUTHORIZED`, `MARKET_NOT_FOUND`, `MARKET_NOT_IN_PRIMARY`, `AMOUNT_TOO_SMALL`, `INVALID_MARKET_PARAMS`, `RATE_LIMITED`.

### `POST /primaryordersubmit/`: register the broadcast signature

Body: `{ orderId, signature, wallet? }`. Answer: `{ orderId, status: "submitted", signature }`. It does not wait for finalization, and a retry with the same `orderId` and `signature` is safe. (`POST /primaryorderverify/` returns the order status: `built`, `submitted`, `confirmed`, `failed` or `expired`. SiteCheck doesn't use it yet.)

### `POST /trades/`: trade attribution

Body: `{ signature, wallet, marketId, quoteId?, clientOrderId?, userId? }`. `userId` defaults to the API key's account. Answer: `{ signature, status: "processed", marketId, wallet, side, kind: "buy"|"claim" }`. Verification is fail-closed: the transaction must exist at the required commitment, succeed, call Panta's USDC program with `primary_order_usdc` (a buy) or `claim_win_usdc` (a win claim), and match the wallet, market and amounts. The call is idempotent per signature. Errors: `TX_NOT_FOUND` (not seen yet), `TX_FAILED`, `TX_MISMATCH`, `TX_FEE_MISMATCH`, `UNAUTHORIZED`, `INVALID_MARKET_PARAMS`, `RATE_LIMITED`. `GET /trades/{signature}/` returns `processed`, `pending_attribution`, `unknown` or `failed`.

### Not used (yet)

Create market (`/markets/create/quote|build/`, `/markets/register/`, image upload), positions (`GET /positions/?wallet=`), win claims (`POST /claim/build/`), creator fees (`POST /claim/creator-fees/build/`), wallet trades, categories, and the account and metrics routes. Positions and win claims are the natural next tools (see the end of this page).

## Attribution: what Panta requires and what SiteCheck does

**Display ("Powered by Panta").** Section 6 of the Terms: any product that uses the Panta API to display Panta markets, market data, market intelligence or trading functionality must display exactly **"Powered by Panta"**. It must be clear and legible, in a place associated with the Panta-powered functionality, linked to [panta.market](https://panta.market) where links are possible, and never removed or obscured (white-label only by written agreement). `CONTRIBUTING.md` in the playground repeats this for forks and demos. SiteCheck does this:

- every JSON response of the market tools, errors included, carries `"poweredBy": { "text": "Powered by Panta", "url": "https://panta.market" }`;
- the landing page's "Prediction markets (Panta)" section ends with a "Powered by Panta" link to panta.market, and the page footer repeats it;
- the x402 and OpenAPI descriptions of each market tool say "Powered by Panta", and so do the README and this repo.

**Trades (partner attribution).** Trades are attributed to the API key's account (or to `userId` / `X-User-Id`). The confirm step, after the buyer broadcasts, is to send Panta the signature: `POST /primaryordersubmit/` with `orderId` and `/trades/` with the signature, wallet and market. The docs describe `/trades/` as "the explicit reporting path" and say buys with an attribution memo "may be ingested automatically". SiteCheck therefore doesn't count on automatic ingestion. `build-buy` returns the fields the report needs (`orderId`, `quoteId`, `id`, `wallet`), and the free `POST /api/markets/report` forwards the signature to both endpoints. Volume attributed this way shows up under the SiteCheck account in `GET /account/metrics/`.

## How SiteCheck maps it

| SiteCheck route | Price | Panta calls |
|---|---|---|
| `GET /api/markets?q=&status=&category=&limit=` | $0.002 | `GET /markets/` (all pages, up to 5 × 50 rows, cached 45 s per `status`/`category`), then `GET /markets/{id}/` for each returned row (cached 15 s) |
| `GET /api/markets/brief?id=` | $0.01 | `GET /markets/{id}/` + `GET /markets/{id}/trades/?limit=50` (cached 30 s), then Workers AI (Llama 3.3 70B) for the summary |
| `POST /api/markets/quote` | $0.005 | `POST /primaryorderquote/` + `GET /markets/{id}/` (spot price, for the price impact) |
| `POST /api/markets/build-buy` | $0.01 | `POST /primaryorderquote/`, then `POST /primaryorderbuild/` |
| `POST /api/markets/report` | free | `POST /primaryordersubmit/` (when `orderId` is given) + `POST /trades/` |

- **Search.** Panta has no text search, so SiteCheck scans the catalog and matches every word at the start of a word, in the title, description or category. `bitcoin`/`btc`, `ethereum`/`eth` and `solana`/`sol` count as the same word. Open markets come first, then more words in the title, then more volume. The response says how many rows were scanned and whether the scan reached the end of the catalog (`catalogComplete`).
- **Odds.** A price is the USDC cost of a share that pays 1 USDC if its side wins, so it reads as an implied probability. The two sides need not sum to exactly 1, so `impliedProbability` is normalized (`yes / (yes + no)`), and `priceUsdc` keeps Panta's raw prices. Rows whose live price couldn't be read keep `priceUsdc: null` and `pricesAsOf: null`, and the search doesn't fail because of them.
- **Freshness.** Responses carry `catalogAsOf` / `pricesAsOf`, so cached data is never presented as newer than it is (Terms, sections 5 and 8). Quotes and builds are never cached.
- **Brief.** It returns the market, its prices by source (`primary` / `secondary`), recent activity from the trade tape (count, YES vs NO buys, trades in the last 24 h, last trade time) and a 3 to 4 sentence summary. The model is told to be neutral, to treat the creator's text as data, and never to advise. If its answer contains advice-like wording (should, recommend, "buy YES", undervalued…), is empty or too long, or the model fails, a deterministic template summary is returned instead (`summary.source: "template"`).
- **Price impact** = `(avgPrice − spot price of that side) / spot price`, from Panta's quote and the market detail. It is `null` when the spot price is unavailable.
- **Unsigned transaction.** `build-buy` returns Panta's instructions unchanged and, as a convenience, the same instructions compiled into an unsigned Solana v0 transaction (base64) with `@solana/kit`. The buyer's wallet is the fee payer, and every signature slot stays empty. Only named fields are copied from Panta's answer, so nothing unexpected passes through. If Panta's order names another wallet, market or side, or has no instructions, the call fails closed with a 502 and no payment is settled. The tests decode the transaction and check that no signature is present.
- **Settle only on success.** Any Panta failure becomes a 4xx/5xx, so the x402 middleware never settles it:

  | Panta | SiteCheck |
  |---|---|
  | 400, 409, 413 (bad input, amount too small, market not in primary, stale quote…) | 400 with Panta's `code`, `message`, `field` |
  | 404 (`MARKET_NOT_FOUND`, `TX_NOT_FOUND`) | 404 (for `report`, `TX_NOT_FOUND` is a 202 "pending, report again") |
  | 401, 403 (our key) | 502, and logged as `[panta] … answered 401` without the key |
  | 429 | 503 with `Retry-After` |
  | timeout (8 s reads, 10 s quote/report, 12 s build) | 504 |
  | 5xx, HTML, network error | 502 |

- **Config.** The `PANTA_API_KEY` Worker secret switches the tools on. `PANTA_BASE_URL` ([vars]) defaults to the live URL and must be https. Without a key, the routes are left out of the 402 catalog, `/.well-known/x402`, `openapi.json` and the landing page, and they answer 404. `GET /health` shows `markets: { enabled: false, reason: "PANTA_API_KEY secret is not set" }`. The key is sent only to Panta, in `X-Api-Key`, and never appears in a response or a log.

## Open questions and uncertainties

1. **Reselling access (Terms 7(g) and 3).** The Terms forbid reselling "raw API access, credentials or substantially unmodified Panta data as a substitute for Panta's own service" without written permission, and forbid credentials being used to let others "circumvent Panta's onboarding or access controls". SiteCheck adds its own layer: search across the catalog, normalized odds, activity, the AI brief, compiled transactions, and x402 payment for agents with no account. It also keeps Panta's attribution and routes the resulting trade volume to a Panta partner account. Even so, charging per call for data from Panta is close enough to 7(g) that **the owner should ask Panta for a written OK** (Discord `#dev-chat`, <https://discord.gg/M76nH6fUwc>) before promoting it. The sidetrack brief explicitly invites "AI + prediction markets" and "existing product integration" entries, which supports the use case, but it is not a license.
2. **Price of the API.** No pricing is published. Signing up is free and self-serve, but the Terms allow fees later.
3. **`pk_test_` vs `pk_live_`.** Both are "accepted on the public API" at `live-api.panta.market`. The docs don't say whether a test key reaches a sandbox or the same live markets. Use a **`live`** key for production.
4. **Undocumented row fields.** The playground's types also read `oracle`, `totalVolumeUsdc`, `creatorAddress` and `creationFee` on catalog rows; the docs' field table doesn't list them. SiteCheck shows `oracle` (the market's sources of truth) as `resolutionSource` and `totalVolumeUsdc` when present. Otherwise they are `null` or left out.
5. **Trade tape units.** The docs' example shows `yesAmount: "10.00"`, but the playground formats these values as 1e6 base units. SiteCheck only counts trades and sides, and never reports sizes from the tape.
6. **No price history.** There is no endpoint for past prices. "Recent price context" is therefore trading activity, not a price chart.
7. **Unfunded wallets.** The docs don't say whether quote or build check the buyer's USDC balance or token account. A quote for an empty wallet may work while the build or the transaction fails.
8. **Rate limits are per account.** Every agent shares SiteCheck's key: 120 reads, 30 quotes and 20 builds per minute by default. A search makes up to 5 catalog calls (cached for 45 s) and up to 20 detail calls (cached for 15 s). Above the limit, buyers get a 503 and are not charged.
9. **Jurisdiction.** Section 10 of the Terms makes the integrator responsible for whether trading is lawful where it is offered. SiteCheck is information-only and never trades or signs. It does not geo-restrict, and it doesn't know whether Panta's own API does.
10. **Report timing.** `/trades/` verifies at a commitment level that the docs don't specify, so a fresh signature can return `TX_NOT_FOUND`. SiteCheck answers `202` with `retryAfterSec: 10`.

## Next tools (not built)

- `GET /api/markets/positions?wallet=`: `GET /positions/` plus market prices, valued as the docs describe (shares × side price while open; about 1 USDC per winning share after resolution).
- `POST /api/markets/build-claim`: `POST /claim/build/` for resolved winners, reported through `/trades/` (`kind: claim`).
