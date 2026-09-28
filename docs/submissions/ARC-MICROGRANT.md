# Arc Microgrants (DoraHacks)

Program: <https://dorahacks.io/hackathon/arc-microgrants>. There are 20 grants of 500 USDC, paid in USDC on Arc. Submissions close **October 14, 2026, 23:59 ET**. Reviews are rolling, and every decision is issued by October 21.

What the program asks for: a live deployment on Arc mainnet with a link, a public repo, a short description of what the project does and what it uses Arc for, and a public builder profile (GitHub, X or Farcaster). Testnet-only builds and projects with no Arc component are not eligible.

## Before you submit (owner checklist)

1. Deploy with `PAY_TO_ARC` set and the `CIRCLE_API_KEY` secret added (see the README).
2. Open `https://api.sitecheck-api.workers.dev/health` and check that `"arc"` is in `networks`.
3. Fund the demo wallet with about 0.10 USDC on Arc, run `node scripts/demo-agent.mjs --network arc`, and copy the transaction link it prints. That link is the proof of a live Arc mainnet payment.
4. Optional: also run `POST /api/embed` ($0.001) on Arc once, to confirm Circle accepts the smallest price (see docs/NETWORKS.md, "Minimum amount").
5. Fill in the `[...]` placeholders below.

## Form fields

**BUIDL name**
SiteCheck

**Tagline**
Pay-per-call AI and web tools for agents, paid in USDC with x402, now on Arc.

**Short description (what it does, and what it uses Arc for)**
SiteCheck is a live HTTP API with eight tools for AI agents: website accessibility audits (WCAG 2.2), company contact lookup, a Hacker News jobs search, LLM chat, image generation, speech-to-text, text-to-speech and embeddings. There is no signup and no API key. Every call is paid on its own, from $0.001 to $0.02, with the x402 protocol.

Arc is one of the three networks it accepts. When an agent calls an endpoint, the `402 Payment Required` answer includes an Arc option: USDC at `0x3600…0000` on `eip155:5042`. The agent signs an EIP-3009 authorization. SiteCheck runs the tool, and only if the tool succeeds does it settle the payment through Circle's Facilitator Service on Arc. The agent needs nothing but USDC, because Circle's relayer pays the gas. Arc's instant finality means the payment is final before the result is returned.

**Live deployment on Arc mainnet**
- API and landing page: https://api.sitecheck-api.workers.dev
- Discovery: https://api.sitecheck-api.workers.dev/.well-known/x402 (lists the Arc network, USDC asset and receiving address)
- Example Arc mainnet payment: `[explorer.arc.io/tx/... link from step 3]`
- Receiving address on Arc: `[PAY_TO_ARC]`

**Public repo**
https://github.com/bck-stack/sitecheck-x402 (MIT)

**Builder profile**
GitHub: https://github.com/bck-stack · `[X or Farcaster, if any]`

**Tags**
x402, USDC, agent payments, AI agents, API, Circle Facilitator Service

## Longer description (for the BUIDL page body)

**Problem.** AI agents can call APIs, but they can't sign up for accounts, enter card details or manage API keys for every service they need. Most useful APIs are locked behind exactly that.

**What SiteCheck does.** It prices each call instead. An agent calls `GET /api/audit?url=example.com` and gets a 402 listing the price on Base, Solana and Arc. It pays on the network it holds USDC on and gets the result in the same request. If the tool fails, the payment is not settled.

**How Arc is used.**
- Arc is a first-class payment option on all eight endpoints: the `accepts` entry on `eip155:5042` for USDC at `0x3600000000000000000000000000000000000000`, with the EIP-712 domain `USDC` / `2`. This was checked on chain against the contract's `DOMAIN_SEPARATOR`.
- Settlement goes through Circle's Facilitator Service (`api.circle.com/v1/facilitator/x402`), which screens both parties, pays gas and returns the transaction hash. SiteCheck does not run a relayer or hold a gas balance.
- The x402 client library does not yet know Arc's USDC, so the landing page, README and demo agent show the one-line opt-in that buyers need (`spendControls.allowedAssets`).
- A demo agent (`scripts/demo-agent.mjs --network arc`) discovers the API, pays on Arc and prints the Arc explorer link.

**Built with.** Cloudflare Workers, Workers AI, Hono, the x402 packages (`@x402/hono`, `@x402/evm`, `@x402/svm`) and Circle Facilitator Service.

**Status, honestly.** The API has been live since September 2026 (Base first) and is listed on x402scan. The Arc and Solana payment options are new: the code was added on 2026-09-28 and goes live with the deployment above. There have been no paying customers yet.

**What the grant would go to.** Keeping the Arc option running and tested: mainnet test payments on Arc, and adding Arc-specific examples to the docs.
