import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

export const SERVICE = "SiteCheck";
const TOOLS = "Pay-per-call tools for AI agents: image generation, speech-to-text, text-to-speech, embeddings, LLM chat, website audits and contact enrichment.";
const list = (names) => names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0];
const MARKETS = " Plus prediction-market search, briefs, quotes and unsigned buy transactions, powered by Panta.";
export const about = (networks, { markets = false } = {}) => `${TOOLS}${markets ? MARKETS : ""} Payment: x402, USDC${networks.length ? ` on ${list(networks.map((n) => n.name))}` : ""}. No signup, no API key.`;

// The paid routes on this deployment: the prediction-market tools only when PANTA_API_KEY is set.
export const catalogFor = ({ markets = false } = {}) => (markets ? { ...CATALOG, ...MARKET_CATALOG } : CATALOG);

// One route per tool, with one x402 `accepts` entry per active network (see lib/networks.js).
export function buildRoutes(networks, catalog = CATALOG) {
  return Object.fromEntries(Object.entries(catalog).map(([route, t]) => [route, {
    accepts: networks.map((n) => ({ scheme: "exact", price: t.price, network: n.network, payTo: n.payTo })),
    description: t.description, mimeType: "application/json", serviceName: SERVICE, tags: t.tags,
    extensions: declareDiscoveryExtension(route.startsWith("POST ")
      ? { bodyType: "json", input: t.input, inputSchema: t.inputSchema, output: { example: t.example } }
      : { input: t.input, inputSchema: t.inputSchema, output: { example: t.example } }),
  }]));
}

const tool = (price, description, tags, input, inputSchema, example) => ({ price, description, tags, input, inputSchema, example });
const urlSchema = { properties: { url: { type: "string", description: "Website URL or domain, e.g. example.com" } }, required: ["url"] };

// Price is in USD and charged in USDC on whichever network the buyer picks.
export const CATALOG = {
  "POST /api/image": tool("$0.005",
    "Generate an image from a text prompt (FLUX.1 schnell). Returns a base64 JPEG. Fast, 1024x1024.",
    ["image generation", "text-to-image", "flux", "ai", "images"], { prompt: "a red fox in the snow, photo", steps: 4 },
    { properties: { prompt: { type: "string", description: "Up to 2048 chars" }, steps: { type: "integer", description: "1-8, default 4" } }, required: ["prompt"] },
    { model: "@cf/black-forest-labs/flux-1-schnell", mime: "image/jpeg", image_base64: "/9j/4AAQ..." }),
  "POST /api/transcribe": tool("$0.01",
    "Speech-to-text with Whisper large-v3-turbo: send an https audio URL (or base64) up to 25 MB, get the transcript, language and timestamped segments.",
    ["speech-to-text", "transcription", "whisper", "audio", "stt"], { url: "https://example.com/audio.mp3" },
    { properties: { url: { type: "string", description: "https URL of an audio file (mp3, wav, m4a...)" }, audio_base64: { type: "string", description: "Alternative to url" }, language: { type: "string", description: "Optional ISO code, e.g. en" } } },
    { model: "@cf/openai/whisper-large-v3-turbo", text: "Hello and welcome...", language: "en", duration: 42.1, segments: [{ start: 0, end: 3.2, text: "Hello and welcome" }] }),
  "POST /api/tts": tool("$0.02",
    "English text-to-speech with Deepgram Aura-2: natural voices, up to 1000 chars per call. Returns base64 MP3.",
    ["text-to-speech", "tts", "voice", "audio", "speech"], { text: "Hello from your agent.", voice: "luna" },
    { properties: { text: { type: "string", description: "Up to 1000 chars" }, voice: { type: "string", description: "luna, asteria, athena, helena, hera, aurora, orion, apollo, arcas, atlas, hermes, zeus, draco, odysseus" } }, required: ["text"] },
    { model: "@cf/deepgram/aura-2-en", voice: "luna", mime: "audio/mpeg", audio_base64: "SUQzBAAAAAAA..." }),
  "POST /api/embed": tool("$0.001",
    "Multilingual text embeddings (BGE-M3, 1024 dimensions) for up to 100 texts per call. For search, RAG and clustering.",
    ["embeddings", "vector", "rag", "semantic search", "bge-m3"], { text: ["first document", "second document"] },
    { properties: { text: { description: "A string or an array of up to 100 strings" } }, required: ["text"] },
    { model: "@cf/baai/bge-m3", dimensions: 1024, embeddings: [[0.012, -0.034]] }),
  "POST /api/chat": tool("$0.004",
    "LLM chat completion with Llama 3.3 70B (fast): send messages or a prompt, up to 2048 output tokens.",
    ["llm", "chat", "llama", "text generation", "completion"], { prompt: "Summarize the benefits of x402 in two sentences.", max_tokens: 256 },
    { properties: { prompt: { type: "string" }, messages: { type: "array", description: "[{role, content}]" }, max_tokens: { type: "integer", description: "Up to 2048" }, temperature: { type: "number" } } },
    { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", response: "x402 lets agents pay per request...", usage: { prompt_tokens: 20, completion_tokens: 40 } }),
  "GET /api/audit": tool("$0.02",
    "Website audit in one call: WCAG 2.2 accessibility issues (European Accessibility Act) with fixes and a score, SEO basics, security headers and tech stack.",
    ["accessibility", "wcag", "seo", "audit", "website"], { url: "example.com" }, urlSchema,
    { url: "https://example.com/", accessibility: { score: 85, issues: [{ severity: "critical", rule: "image-alt", wcag: "1.1.1", count: 3, fix: "Add alt text" }] }, seo: { title: "Example" }, security: { hsts: true }, tech: ["Shopify"] }),
  "GET /api/contacts": tool("$0.01",
    "Company contact enrichment from a domain: emails (same-domain flagged), phones, social profiles, description and tech stack, read from the home, contact, about and legal pages.",
    ["enrichment", "contacts", "email", "company", "leads"], { url: "plausible.io" }, urlSchema,
    { domain: "plausible.io", name: "Plausible Analytics", emails: [{ email: "hello@plausible.io", sameDomain: true }], socials: { linkedin: "https://linkedin.com/company/plausible-analytics/" }, tech: ["Cloudflare"] }),
  "GET /api/hiring": tool("$0.01",
    "Search the current Hacker News 'Who is hiring?' thread: companies hiring, filtered by keywords and remote, with contact emails and links.",
    ["jobs", "hiring", "hacker news", "leads", "remote"], { q: "python", remote: "1", limit: "20" },
    { properties: { q: { type: "string", description: "Keywords, all must match" }, remote: { type: "string", description: "1 = remote only" }, limit: { type: "string", description: "Max results, up to 100" } } },
    { thread: { title: "Ask HN: Who is hiring? (September 2026)" }, total: 38, results: [{ company: "Acme", headline: "Acme | Backend Engineer | REMOTE", emails: ["jobs@acme.com"], url: "https://news.ycombinator.com/item?id=1" }] }),
};

// Prediction markets, powered by the Panta API (lib/markets.js). Information only, not financial advice.
// build-buy returns an unsigned transaction; SiteCheck never signs, holds keys or custodies funds.
// POST /api/markets/report is free and not listed here (see lib/app.js).
const MARKET_ID = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const orderSchema = {
  properties: {
    id: { type: "string", description: "Panta market id (the market's event address, base58), from GET /api/markets" },
    side: { type: "string", description: "yes or no" },
    amountUsdc: { type: "string", description: 'USDC to spend, as a decimal string, e.g. "5.00"' },
    wallet: { type: "string", description: "The buyer's Solana wallet (base58). It pays and signs; SiteCheck never does." },
  },
  required: ["id", "side", "amountUsdc", "wallet"],
};
const orderInput = { id: MARKET_ID, side: "yes", amountUsdc: "5.00", wallet: WALLET };

export const MARKET_CATALOG = {
  "GET /api/markets": tool("$0.002",
    "Search Panta prediction markets (USDC on Solana) by keywords, phase or category. Compact rows: question, YES/NO implied probability from live prices, volume, close and resolution times, resolution source. Powered by Panta. Information only, not financial advice.",
    ["prediction markets", "odds", "panta", "solana", "market data"], { q: "bitcoin", status: "primary", limit: "5" },
    { properties: { q: { type: "string", description: "Keywords, all must match (title, description, category)" }, status: { type: "string", description: "primary (open for buys), secondary, resolved or cancelled" }, category: { type: "string", description: "Optional: sports, crypto, politics, entertainment, finance, science, world, other" }, limit: { type: "string", description: "Max results, 1-20, default 10" } } },
    { total: 3, results: [{ id: MARKET_ID, question: "Will BTC close above $150k on 2026-12-31?", phase: "primary", priceUsdc: { yes: 0.31, no: 0.69 }, impliedProbability: { yes: 0.31, no: 0.69 }, volumeUsdc: 1200, closesAt: "2026-12-31T23:59:59.000Z", resolutionSource: "https://www.coingecko.com", buyable: true }], disclaimer: "Information only, not financial advice.", poweredBy: { text: "Powered by Panta", url: "https://panta.market" } }),
  "GET /api/markets/brief": tool("$0.01",
    "One Panta prediction market in depth: current YES/NO odds, recent trading activity and a short neutral AI summary of what it asks, what resolves it and what the price implies. No advice. Powered by Panta.",
    ["prediction markets", "odds", "panta", "research", "summary"], { id: MARKET_ID },
    { properties: { id: { type: "string", description: "Panta market id, from GET /api/markets" } }, required: ["id"] },
    { market: { id: MARKET_ID, question: "Will BTC close above $150k on 2026-12-31?", impliedProbability: { yes: 0.31, no: 0.69 } }, recentActivity: { sampled: 50, yesBuys: 31, noBuys: 19, last24h: 12 }, summary: { text: "This market asks whether...", source: "llm" }, disclaimer: "Information only, not financial advice." }),
  "POST /api/markets/quote": tool("$0.005",
    "Quote a YES or NO buy on a Panta market for a USDC amount and wallet: expected shares, average fill price, fee and price impact against the spot price. Nothing is signed or sent. Powered by Panta.",
    ["prediction markets", "quote", "panta", "solana", "trading"], orderInput, orderSchema,
    { expectedFill: { shares: 15.8, avgPrice: 0.3165, feeUsdc: 0.1 }, spotPrice: 0.31, priceImpact: 0.021, disclaimer: "Information only, not financial advice." }),
  "POST /api/markets/build-buy": tool("$0.01",
    "Build an unsigned Panta buy transaction (Solana v0, base64, plus the raw instructions) for your own wallet to sign and broadcast. SiteCheck never signs, holds keys or custodies funds. Then report the signature to POST /api/markets/report (free).",
    ["prediction markets", "unsigned transaction", "panta", "solana", "trading"], { ...orderInput, maxSlippageBps: 100 },
    { properties: { ...orderSchema.properties, maxSlippageBps: { type: "integer", description: "1-5000, default 100 (1%)" } }, required: orderSchema.required },
    { order: { orderId: "ord_...", quoteId: "qt_...", expectedShares: "15.80", feeUsdc: "0.10" }, transaction: { signed: false, format: "solana-v0", encoding: "base64", data: "AQAAAA...", feePayer: WALLET }, instructions: [{ programId: "...", data: "<base64>", accounts: [] }], disclaimer: "Information only, not financial advice." }),
};
