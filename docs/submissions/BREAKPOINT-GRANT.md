# Superteam UK: Build for Breakpoint (Agentic Grants)

Listing: <https://superteam.fun/earn/grants/build-for-breakpoint> (Superteam Earn). The cheque size is 200 USDG. Questions go to uk@superteam.fun. Breakpoint 2026 is in London in November.

> **Check eligibility first.** The listing says: "This grant is only open for people in United Kingdom." The founder runs a UK company but lives in Istanbul. Before applying, email uk@superteam.fun, describe exactly that situation, and ask whether it qualifies. The answers below state it openly either way.

Fill in the `[...]` placeholders before submitting.

## Project name
SiteCheck

## One-line description
Pay-per-call AI and web tools for AI agents: no accounts, no API keys, paid per request in USDC with x402, now on Solana.

## What are you building?
SiteCheck is a live HTTP API (https://api.sitecheck-api.workers.dev) with eight tools for AI agents: website accessibility audits (WCAG 2.2), company contact lookup, a Hacker News jobs search, LLM chat, image generation, speech-to-text, text-to-speech and embeddings. Agents don't sign up or manage keys. They pay for each call, from $0.001 to $0.02, in USDC with the x402 protocol, and a failed call is never charged. It is open source (MIT): https://github.com/bck-stack/sitecheck-x402

Until now it accepted payment on Base only. The Solana integration is written and tested: every endpoint now also offers a Solana USDC payment option, settled through the PayAI facilitator, which pays the transaction fee so the agent needs only USDC.

## What will you build and ship before Breakpoint?
All of this is due before Breakpoint 2026 (London, November):
1. **Solana payments live on mainnet** on all eight endpoints, next to Base and Arc, with the receiving address published in `/.well-known/x402` and the OpenAPI document.
2. **A public proof:** a real mainnet payment on Solana made by the open-source demo agent (`node scripts/demo-agent.mjs --network solana`), with the Solscan link in the README.
3. **A 3-minute demo video** of an agent discovering the API and paying on Solana, Base and Arc.
4. **Docs for other builders:** a clear guide to accepting x402 payments on Solana from a Cloudflare Worker, including the non-obvious parts (the receiver's USDC token account must exist; the facilitator is the fee payer).

Links once live: Solana transaction `[solscan link]`, video `[link]`.

## How do you use AI coding tools?
In two ways.
- **Building it:** the codebase is written with AI coding agents under the founder's review. The Solana and Arc integration was researched, implemented and tested with Claude Code. That covered reading the x402 package source to find the right scheme and facilitator APIs, checking Arc's USDC contract on chain, writing the per-network payment wiring, and writing tests that mock both facilitators. The founder reviews every change, holds all keys and does the deployments. `[Add any other tools you use, e.g. Cursor, Copilot.]`
- **What it's for:** SiteCheck's customers are AI agents themselves. It is built so that an agent can find it (`/.well-known/x402`, OpenAPI, x402 Bazaar schemas), understand the price and pay without a human in the loop.

## Are you part of an accelerator or program?
We are entering Colosseum's **Crypto World's Fair** hackathon (submissions close October 12, 2026), in the Solana and Base tracks and for the Public Goods Award. Top teams there are considered for Colosseum's accelerator. We have not been accepted into any accelerator.

## Traction
Live since September 2026, listed on x402scan, open source. **No paying customers yet**; any payments so far are our own tests. The honest goal for Breakpoint is a working Solana payment path that other builders and agents can use and copy.

## Team and company
`[Founder name]`, founder `[add other team members, if any]`. The founder runs **Offera Studio Ltd**, a UK company (Companies House number **17168714**), and is based in **Istanbul, Turkey**. GitHub: https://github.com/bck-stack · X: `[handle]`

## How will you use the grant?
It covers the running costs of the Solana launch until Breakpoint: the Cloudflare Workers plan that hosts the API and the models, and the mainnet USDC for test payments and the demo video.
