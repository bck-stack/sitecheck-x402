# Payment networks

SiteCheck accepts x402 payments in USDC on three networks. Every paid route advertises one `exact` payment option per configured network, and the buyer's client picks the one it has funds on. This page records the facts each setting is based on, where they come from, and the decisions made. Everything was checked on 2026-09-28.

## Summary

| | Base | Solana | Arc |
|---|---|---|---|
| CAIP-2 id | `eip155:8453` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `eip155:5042` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `0x3600000000000000000000000000000000000000` |
| Decimals | 6 | 6 | 6 (ERC-20 interface) |
| How the buyer pays | EIP-3009 `transferWithAuthorization` signature | partially signed SPL `TransferChecked` transaction | EIP-3009 `transferWithAuthorization` signature |
| EIP-712 domain | `USD Coin`, version `2` | n/a | `USDC`, version `2` |
| Facilitator | PayAI | PayAI | Circle Facilitator Service |
| Facilitator URL (var) | `FACILITATOR_URL` | `FACILITATOR_URL` | `FACILITATOR_URL_ARC` |
| Receiving address (var) | `PAY_TO` | `PAY_TO_SOLANA` | derived from the `ARC_SELLER_KEY` secret (`PAY_TO_ARC` optional, must match) |
| Extra requirement | none | `PAY_TO_SOLANA` must already have a USDC token account | Worker secret `ARC_SELLER_KEY` (keyless trial); fallback: `PAY_TO_ARC` + `CIRCLE_API_KEY` |
| Gas paid by | facilitator | facilitator (fee payer) | facilitator (Circle relayer) |

A network is offered only when its receiving address is set and valid. Arc is on when `ARC_SELLER_KEY` is set (or, without it, when both `PAY_TO_ARC` and `CIRCLE_API_KEY` are set). `GET /health` lists the active networks and says why any network is switched off. For Arc it also shows the auth mode, the receiving address and whether Circle has reported the trial as used up.

## x402 packages

Versions: `@x402/core`, `@x402/evm`, `@x402/svm`, `@x402/hono`, `@x402/extensions`, `@x402/fetch` 2.27.0.

- **Several networks per route.** A route's `accepts` can be an array. `x402ResourceServer` builds one payment requirement per entry (`buildPaymentRequirementsFromOptions`), so the 402 lists them all.
- **Several facilitators.** `new x402ResourceServer([clientA, clientB])` asks each facilitator for `/supported` and routes each network and scheme to the first facilitator that lists it. Circle lists Base too, so `lib/payments.js` wraps each client so that it reports only the networks we assign to it (`scopedFacilitator`). Base goes to PayAI regardless of list order.
- **Solana scheme.** `@x402/svm` (`ExactSvmScheme` from `@x402/svm/exact/server`) needs the peer dependency `@solana/kit`. The server copies the facilitator's `feePayer` from `/supported` into the requirement. The client builds a `TransferChecked` to the receiver's associated token account; it does not create that account.
- **Arc prices.** `@x402/evm` 2.27.0 has no default asset for `eip155:5042`, so a `"$0.02"` price would throw. `lib/payments.js` registers a money parser for Arc that returns the USDC address and the EIP-712 domain (`USDC`, `2`).
- **Arc on the client side.** For the same reason, a stock x402 client rejects the Arc option ("rejected by spendControls") unless it opts in: `x402Client.fromConfig({ ..., spendControls: { allowedAssets: [{ network: "eip155:5042", asset: "0x3600000000000000000000000000000000000000", maxAmountPerPayment: "100000" }] } })`. The landing page and `scripts/demo-agent.mjs` do this.
- **Arc's facilitator client.** `@x402/core`'s `HTTPFacilitatorClient` builds the request body inside `verify()`/`settle()`, and its auth-header hook never sees that body. A seller proof has to hash the exact body bytes, so `lib/circle.js` has its own small client for Circle. It serializes the body once, signs those bytes, and sends the same bytes. `/supported` still goes through `HTTPFacilitatorClient`, without auth.
- **Settle after the handler.** With the default `exact` flows (EVM `eip3009`, SVM `default`), the Hono middleware verifies before the handler and settles after it. Settlement is skipped when the handler returns a status of 400 or above or throws, so a failed call is never charged. A settle response with `success: false` returns 402 and drops the result.
- **Initialization on Workers.** The Hono middleware normally starts `initialize()` when it is created and shares that promise between requests. On Workers a request can't await a promise created by another request. Also, `@x402/core` calls `process.exit(1)` if that background init fails with a route configuration error. So `createPaymentMiddleware` awaits `initialize()` inside the current request and creates the middleware with `syncFacilitatorOnStart = false`. The app caches the first middleware that finished initializing. If init fails (for example, a facilitator is down), the request gets a 503 and the next request tries again.

Sources: the package code in `node_modules/@x402/*/dist/esm`, [x402 repository](https://github.com/x402-foundation/x402), [x402 docs](https://docs.x402.org/).

## Base

Unchanged from the first version. [PayAI's `/supported`](https://facilitator.payai.network/supported) lists `exact` on `eip155:8453` for x402 v2. The USDC domain (`USD Coin`, `2`) comes from `@x402/evm`'s default asset table.

## Solana

- Network id `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` and USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` are the `@x402/svm` constants (`SOLANA_MAINNET_CAIP2`, `USDC_MAINNET_ADDRESS`).
- PayAI's `/supported` lists `exact` on that network for x402 v2, with its `feePayer` address in `extra`. The facilitator pays the transaction fee, so the buyer needs no SOL.
- **Receiving address:** `PAY_TO_SOLANA` is a normal wallet address (base58). Its USDC associated token account must already exist, or every transfer fails. A wallet that has received USDC once has one. In Phantom or Solflare, adding USDC and receiving any small amount creates it.
- Decision: PayAI for Solana, because it already serves Base for this API, lists Solana mainnet, and needs no key.

## Arc

Facts, from Arc's docs and checked on chain through `https://rpc.mainnet.arc.io`:

- Chain id `5042` (`eth_chainId` returns `0x13b2`). Explorer: `https://explorer.arc.io`. Testnet is `5042002`. ([Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc))
- USDC is Arc's native gas token. Its optional ERC-20 interface lives at `0x3600000000000000000000000000000000000000` with **6 decimals**; the native balance uses 18 decimals. x402 uses the ERC-20 interface. ([Contract addresses](https://docs.arc.io/arc/references/contract-addresses))
- EIP-3009 is supported: the contract returns `name() = "USDC"`, `version() = "2"`, `TRANSFER_WITH_AUTHORIZATION_TYPEHASH = 0x7c7c6cdb…2267`, and its `DOMAIN_SEPARATOR` equals the hash of (`USDC`, `2`, `5042`, `0x3600…0000`).

### Facilitator: Circle Facilitator Service

- **Why not PayAI:** PayAI's `/supported` does not list `eip155:5042`, and PayAI says so in [its post on Arc mainnet](https://blog.payai.network/circles-arc-mainnet-is-live-what-it-means-for-x402-usdc-and-solana/) ("Arc isn't on PayAI's supported network list today"). If PayAI adds Arc later, you can move Arc to PayAI and retire the seller key and the hot wallet; that would be the simpler setup.
- **Endpoint:** `https://api.circle.com/v1/facilitator/x402`, with `POST /verify`, `POST /settle`, `GET /status/{paymentId}` and a public `GET /supported`. The `/supported` response lists `exact` on `eip155:5042` with asset `0x3600…0000` and `extra: { name: "USDC", version: "2" }`. The sandbox is `https://api-sandbox.circle.com`. ([Facilitator Service](https://developers.circle.com/facilitator-service), [Supported networks](https://developers.circle.com/facilitator-service/supported-networks), [Settle API](https://developers.circle.com/api-reference/facilitator-service/settle-payment))
- **Scheme:** x402 v2 `exact` with EIP-3009, signed against the USDC contract. This is exactly what `@x402/evm`'s `ExactEvmScheme` produces. Circle screens buyer and seller, submits `transferWithAuthorization` through its relayer and pays the gas. Arc settlements are final. ([How it works](https://developers.circle.com/facilitator-service/how-it-works))
- **Authentication:** `/verify`, `/settle` and `/status` need either a Circle API key (`Authorization: Bearer …`) or a seller proof (below). A request that carries both is rejected (HTTP 400, "mixed authentication modes"), so exactly one is sent. `/supported` is public and gets neither, so a bad key or proof breaks Arc payments only and never the start-up of the other networks. ([Keyless trial](https://developers.circle.com/facilitator-service/keyless-trial), [Sign a seller proof](https://developers.circle.com/facilitator-service/sign-seller-proof), [Verify](https://developers.circle.com/api-reference/facilitator-service/verify-payment), [Settle](https://developers.circle.com/api-reference/facilitator-service/settle-payment))
- **Decision: the keyless trial, with seller proofs.** The first version used a Circle API key. On mainnet, that key gets `403 {"code":403,"message":"forbidden"}` from `/verify`. The key itself is valid (a made-up key gets 401), but the Circle account is not enabled for mainnet without a credit card on file, and the owner won't add one. The keyless trial needs no Circle account at all. The price is that the receiving wallet's private key has to live in the Worker; see [The receiving (hot) wallet](#the-receiving-hot-wallet).
- **Fallback: API key.** If `ARC_SELLER_KEY` is not set, the Worker uses `PAY_TO_ARC` plus the `CIRCLE_API_KEY` secret as before. If both `ARC_SELLER_KEY` and `CIRCLE_API_KEY` are set, the seller key wins. Settling once with an API key binds the `payTo` to that Circle account and ends its trial allowance. Payment history carries over.
- **Pending settlements:** `/settle` always answers HTTP 200. If the transfer isn't final within the wait window, it returns `success: false` with `errorReason: "settlement_pending"`. The x402 middleware retries the settle once. If it is still pending, the middleware treats it as not paid: the buyer gets a 402 and no result, even though the transfer may still complete. On Arc (instant finality) this should be rare. It is a known limit, and if it happens the payment can be reconciled with `GET /status/{paymentId}`. That call needs a proof too (`purpose: "status"`, method `GET`, hash of an empty body); `sellerProof()` in `lib/sellerProof.js` supports that.
- **Minimum amount:** Circle may refuse a settlement "below the configured minimum" (HTTP 403) but does not publish that minimum. After deploying, pay for the cheapest route on Arc once (`POST /api/embed`, $0.001). If Circle refuses it, raise Arc prices or leave that route off Arc.

### Keyless trial: seller proofs

Circle's keyless trial settles real payments without a Circle account. On the first `/settle` for a new `payTo`, Circle creates a seller account for that address. It keeps settling until the address's trial allowance runs out. There is one allowance per `payTo` per chain. Circle does not publish its size. Every `/settle` call counts, including the middleware's one automatic retry on `settlement_pending`. `/verify` does not count.

Every Circle request then carries a `Facilitator-Seller-Proof` header (`lib/sellerProof.js`, `lib/circle.js`):

- An EIP-712 signature with domain `{ name: "Circle Facilitator Seller Request", version: "1", chainId: 5042 }` over a `SellerRequest` message with these fields: `purpose` (`"verify"`, `"settle"` or `"status"`, matching the route), `method` (`"POST"`), `bodyHash` (keccak256 of the raw request body), `network` and `payTo` (equal to the body's `paymentRequirements`, or Circle answers 401), a random 32-byte `nonce`, `issuedAt` and `expiresAt` (300 seconds later, Circle's maximum).
- The header is the base64url-encoded JSON envelope `{ version: 1, signature, network, payTo, nonce, issuedAt, expiresAt }`. Circle rebuilds `purpose`, `method` and `bodyHash` from the request itself, so a proof can't be reused for another route or another body.
- The body is serialized once. The signature covers exactly those bytes, and fetch sends the same bytes. `/verify` and `/settle` each get their own proof and nonce.
- The signer is `ARC_SELLER_KEY`. The Worker derives Arc's `payTo` from it, so `PAY_TO_ARC` can stay empty. If `PAY_TO_ARC` is set and differs from the key's address, or the key isn't 32 bytes of hex, Arc is switched off and `/health` says why. The key never appears in a response or a log line.
- The tests rebuild the message from Circle's spec, independently of the code. They check that each proof recovers to `payTo`, that `bodyHash` matches the bytes that were sent (a re-serialized or altered body no longer matches), and that `purpose` is right for verify and for settle (`test/arc-keyless.test.js`).

### The receiving (hot) wallet

With the keyless trial, the key that controls Arc's `payTo` sits in the Worker as a secret. So `payTo` is a dedicated wallet that does one thing: it receives Arc payments. Its USDC is swept to the owner's own (cold) wallet regularly.

- **Create it:** `node scripts/new-arc-wallet.mjs`. It writes the key to `.env.arc-seller` (git-ignored, file mode 600) and prints only the address and the next commands. It refuses to overwrite an existing file.
- **Store the key:** `npx wrangler secret put ARC_SELLER_KEY`, then paste the value from that file. Cloudflare stores it encrypted, and the Worker only reads it to sign seller proofs.
- **Sweep it:** `node scripts/sweep-arc.mjs --to <cold address>` shows what it would send; add `--yes` to send. On Arc, USDC is the gas token, and the ERC-20 at `0x3600…0000` (6 decimals) and the native balance (18 decimals) are one balance. So the script sends a plain native transfer of *balance − fee*. It fixes the fee up front (`maxFeePerGas = maxPriorityFeePerGas`, twice the current gas price, with a 20 gwei floor), so the network charges exactly that and refunds nothing, and the wallet ends at exactly 0. At Arc's current 20 gwei base fee, one sweep costs about 0.0008 USDC. The script checks that the RPC is Arc mainnet (chain 5042), and it rejects the hot wallet itself, the zero address and system addresses as the destination.

**The trade-off, honestly.**

- *What we gain:* Arc works with no Circle account, no card and no API key. Circle still screens both parties, pays the gas and returns the transaction hash.
- *What it costs:* a private key that controls money is now online, in the Worker. Anyone who gets it can move whatever the hot wallet holds at that moment and sign seller proofs for this `payTo`. That could happen through a compromised Cloudflare account, a leaked `.env.arc-seller`, or a code change that exposes the secret. Before, the Worker held no keys to funds at all.
- *How the risk is kept small:* the wallet is used for nothing else. Regular sweeps keep its balance low, so a leak loses at most what came in since the last sweep. The key signs only `SellerRequest` messages under Circle's own EIP-712 domain, which can't authorize a USDC transfer. It never appears in the repo, in responses or in logs. If it may have leaked: sweep at once, create a new wallet, and replace the secret.
- *It is temporary:* the trial allowance is limited and unpublished. When it runs out, Arc stops settling until a Circle API key is added, and that needs the card.

### When the trial runs out

When the allowance runs out, `/settle` answers `403` with `errors: [{ reason: "registration_required" }]`. Then:

- That payment is not settled and the buyer gets a 402 with `errorReason: "registration_required"` and no result. The handler has already run, but nobody is charged. As always, a failed handler never settles, on any network.
- The Worker logs `[arc] Circle's keyless trial allowance for the Arc receiving address is used up (403 registration_required) …` once per instance. `GET /health` then shows `arc.trialExhausted: true`, with `trialExhaustedAt` and a warning. That state lives in the memory of the Worker instance that got the answer. A fresh instance shows `false` until it hits the refusal itself, so the logs (`npx wrangler tail`, or Workers Logs in the dashboard) are the reliable record.
- From then on, that instance refuses Arc payments at verify time, before the handler runs. Base and Solana are unaffected.
- A different 403, such as an amount below Circle's minimum, is not treated as the end of the trial.
- What the owner can do: switch Arc off (delete the `ARC_SELLER_KEY` secret and leave `PAY_TO_ARC` empty, then deploy), or add a Circle API key once the account is enabled (set `CIRCLE_API_KEY` and `PAY_TO_ARC`, then delete `ARC_SELLER_KEY`, because the seller key wins while it is set). Sweep the hot wallet either way.

### Not used: Circle Gateway Nanopayments

`https://gateway-api.circle.com/v1/x402` also lists `eip155:5042`, but it is a different model. Buyers first deposit USDC into a Gateway Wallet contract (`0x7777…00eE`), then sign against the `GatewayWalletBatched` EIP-712 domain, and Gateway settles in batches. Standard x402 EVM clients sign against the USDC contract, so they could not pay it without extra setup. It is worth a look later for sub-cent prices. ([What is x402? (Circle)](https://developers.circle.com/x402-facilitators/x402))

## Configuration

```toml
# wrangler.toml
[vars]
PAY_TO = ""          # Base
PAY_TO_SOLANA = ""   # Solana
PAY_TO_ARC = ""      # Arc: optional with ARC_SELLER_KEY (must equal its address)
FACILITATOR_URL = "https://facilitator.payai.network"
FACILITATOR_URL_ARC = "https://api.circle.com/v1/facilitator/x402"
```

```bash
node scripts/new-arc-wallet.mjs            # Arc: creates the hot wallet, key in .env.arc-seller
npx wrangler secret put ARC_SELLER_KEY     # paste the key from .env.arc-seller
# fallback without a seller key: set PAY_TO_ARC and  npx wrangler secret put CIRCLE_API_KEY
```

## Links

- x402: <https://x402.org>, <https://docs.x402.org>, <https://github.com/x402-foundation/x402>
- PayAI facilitator: <https://facilitator.payai.network/supported>
- Circle Facilitator Service: <https://developers.circle.com/facilitator-service>, quickstart <https://developers.circle.com/facilitator-service/quickstart>
- Arc: <https://docs.arc.io>, <https://docs.arc.io/arc/references/connect-to-arc>, <https://docs.arc.io/arc/references/contract-addresses>
- USDC addresses: <https://developers.circle.com/stablecoins/usdc-contract-addresses>
- x402scan discovery spec: <https://github.com/Merit-Systems/x402scan/blob/main/docs/DISCOVERY.md>
