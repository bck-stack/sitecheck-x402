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
| Receiving address (var) | `PAY_TO` | `PAY_TO_SOLANA` | `PAY_TO_ARC` |
| Extra requirement | none | `PAY_TO_SOLANA` must already have a USDC token account | Worker secret `CIRCLE_API_KEY` |
| Gas paid by | facilitator | facilitator (fee payer) | facilitator (Circle relayer) |

A network is offered only when its receiving address is set and valid (and, for Arc, when `CIRCLE_API_KEY` is set). `GET /health` lists the active networks and says why any network is switched off.

## x402 packages

Versions: `@x402/core`, `@x402/evm`, `@x402/svm`, `@x402/hono`, `@x402/extensions`, `@x402/fetch` 2.27.0.

- **Several networks per route.** A route's `accepts` can be an array. `x402ResourceServer` builds one payment requirement per entry (`buildPaymentRequirementsFromOptions`), so the 402 lists them all.
- **Several facilitators.** `new x402ResourceServer([clientA, clientB])` asks each facilitator for `/supported` and routes each network and scheme to the first facilitator that lists it. Circle lists Base too, so `lib/payments.js` wraps each client so that it reports only the networks we assign to it (`scopedFacilitator`). Base goes to PayAI regardless of list order.
- **Solana scheme.** `@x402/svm` (`ExactSvmScheme` from `@x402/svm/exact/server`) needs the peer dependency `@solana/kit`. The server copies the facilitator's `feePayer` from `/supported` into the requirement. The client builds a `TransferChecked` to the receiver's associated token account; it does not create that account.
- **Arc prices.** `@x402/evm` 2.27.0 has no default asset for `eip155:5042`, so a `"$0.02"` price would throw. `lib/payments.js` registers a money parser for Arc that returns the USDC address and the EIP-712 domain (`USDC`, `2`).
- **Arc on the client side.** For the same reason, a stock x402 client rejects the Arc option ("rejected by spendControls") unless it opts in: `x402Client.fromConfig({ ..., spendControls: { allowedAssets: [{ network: "eip155:5042", asset: "0x3600000000000000000000000000000000000000", maxAmountPerPayment: "100000" }] } })`. The landing page and `scripts/demo-agent.mjs` do this.
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

- **Why not PayAI:** PayAI's `/supported` does not list `eip155:5042`, and PayAI says so in [its post on Arc mainnet](https://blog.payai.network/circles-arc-mainnet-is-live-what-it-means-for-x402-usdc-and-solana/) ("Arc isn't on PayAI's supported network list today"). If PayAI adds Arc later, you can move Arc to PayAI and drop the Circle key; that would be the simpler setup.
- **Endpoint:** `https://api.circle.com/v1/facilitator/x402`, with `POST /verify`, `POST /settle`, `GET /status/{paymentId}` and a public `GET /supported`. The `/supported` response lists `exact` on `eip155:5042` with asset `0x3600…0000` and `extra: { name: "USDC", version: "2" }`. The sandbox is `https://api-sandbox.circle.com`. ([Facilitator Service](https://developers.circle.com/facilitator-service), [Supported networks](https://developers.circle.com/facilitator-service/supported-networks), [Settle API](https://developers.circle.com/api-reference/facilitator-service/settle-payment))
- **Scheme:** x402 v2 `exact` with EIP-3009, signed against the USDC contract. This is exactly what `@x402/evm`'s `ExactEvmScheme` produces. Circle screens buyer and seller, submits `transferWithAuthorization` through its relayer and pays the gas. Arc settlements are final. ([How it works](https://developers.circle.com/facilitator-service/how-it-works))
- **Authentication:** `/verify` and `/settle` need either a Circle API key (`Authorization: Bearer …`) or a "seller proof". A seller proof is an EIP-712 signature by the private key of `payTo`, made per request. The key-free trial works with seller proofs only, which would mean keeping the receiving wallet's private key inside the Worker. **Decision:** use an API key, stored as the Worker secret `CIRCLE_API_KEY` and sent only to `/verify` and `/settle`. `/supported` is public, so a wrong key breaks Arc payments only and never the start-up of the other networks. ([Keyless trial](https://developers.circle.com/facilitator-service/keyless-trial), [API keys](https://developers.circle.com/api-reference/keys))
- **Getting the key:** create a free account in [Circle Console](https://console.circle.com/), then create an API key there. Mainnet and testnet keys are separate. The first settlement with a key binds the `payTo` address to that Circle account.
- **Pending settlements:** `/settle` always answers HTTP 200. If the transfer isn't final within the wait window, it returns `success: false` with `errorReason: "settlement_pending"`. The x402 middleware treats that as not paid: the buyer gets a 402 and no result, even though the transfer may still complete. On Arc (instant finality) this should be rare. It is a known limit, and if it happens the payment can be reconciled with `GET /status/{paymentId}`.
- **Minimum amount:** Circle may refuse a settlement "below the configured minimum" (HTTP 403) but does not publish that minimum. After deploying, pay for the cheapest route on Arc once (`POST /api/embed`, $0.001). If Circle refuses it, raise Arc prices or leave that route off Arc.

### Not used: Circle Gateway Nanopayments

`https://gateway-api.circle.com/v1/x402` also lists `eip155:5042`, but it is a different model. Buyers first deposit USDC into a Gateway Wallet contract (`0x7777…00eE`), then sign against the `GatewayWalletBatched` EIP-712 domain, and Gateway settles in batches. Standard x402 EVM clients sign against the USDC contract, so they could not pay it without extra setup. It is worth a look later for sub-cent prices. ([What is x402? (Circle)](https://developers.circle.com/x402-facilitators/x402))

## Configuration

```toml
# wrangler.toml
[vars]
PAY_TO = ""          # Base
PAY_TO_SOLANA = ""   # Solana
PAY_TO_ARC = ""      # Arc
FACILITATOR_URL = "https://facilitator.payai.network"
FACILITATOR_URL_ARC = "https://api.circle.com/v1/facilitator/x402"
```

```bash
npx wrangler secret put CIRCLE_API_KEY   # only needed for Arc
```

## Links

- x402: <https://x402.org>, <https://docs.x402.org>, <https://github.com/x402-foundation/x402>
- PayAI facilitator: <https://facilitator.payai.network/supported>
- Circle Facilitator Service: <https://developers.circle.com/facilitator-service>, quickstart <https://developers.circle.com/facilitator-service/quickstart>
- Arc: <https://docs.arc.io>, <https://docs.arc.io/arc/references/connect-to-arc>, <https://docs.arc.io/arc/references/contract-addresses>
- USDC addresses: <https://developers.circle.com/stablecoins/usdc-contract-addresses>
- x402scan discovery spec: <https://github.com/Merit-Systems/x402scan/blob/main/docs/DISCOVERY.md>
