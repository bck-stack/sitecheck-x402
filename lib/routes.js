import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

export const SERVICE = "SiteCheck";
export const ABOUT = "Pay-per-call tools for AI agents: image generation, speech-to-text, text-to-speech, embeddings, LLM chat, website audits and contact enrichment. Payment: x402, USDC on Base. No signup, no API key.";

export function buildRoutes(PAY_TO, NETWORK) {
  const base = (price, description, tags) => ({
    accepts: { scheme: "exact", price, network: NETWORK, payTo: PAY_TO },
    description, mimeType: "application/json", serviceName: SERVICE, tags,
  });
  const get = (price, description, tags, input, inputSchema, example) => ({
    ...base(price, description, tags),
    extensions: declareDiscoveryExtension({ input, inputSchema, output: { example } }),
  });
  const post = (price, description, tags, input, inputSchema, example) => ({
    ...base(price, description, tags),
    extensions: declareDiscoveryExtension({ bodyType: "json", input, inputSchema, output: { example } }),
  });
  const urlSchema = { properties: { url: { type: "string", description: "Website URL or domain, e.g. example.com" } }, required: ["url"] };

  return {
    "POST /api/image": post("$0.005",
      "Generate an image from a text prompt (FLUX.1 schnell). Returns a base64 JPEG. Fast, 1024x1024.",
      ["image generation", "text-to-image", "flux", "ai", "images"], { prompt: "a red fox in the snow, photo", steps: 4 },
      { properties: { prompt: { type: "string", description: "Up to 2048 chars" }, steps: { type: "integer", description: "1-8, default 4" } }, required: ["prompt"] },
      { model: "@cf/black-forest-labs/flux-1-schnell", mime: "image/jpeg", image_base64: "/9j/4AAQ..." }),
    "POST /api/transcribe": post("$0.01",
      "Speech-to-text with Whisper large-v3-turbo: send an https audio URL (or base64) up to 25 MB, get the transcript, language and timestamped segments.",
      ["speech-to-text", "transcription", "whisper", "audio", "stt"], { url: "https://example.com/audio.mp3" },
      { properties: { url: { type: "string", description: "https URL of an audio file (mp3, wav, m4a...)" }, audio_base64: { type: "string", description: "Alternative to url" }, language: { type: "string", description: "Optional ISO code, e.g. en" } } },
      { model: "@cf/openai/whisper-large-v3-turbo", text: "Hello and welcome...", language: "en", duration: 42.1, segments: [{ start: 0, end: 3.2, text: "Hello and welcome" }] }),
    "POST /api/tts": post("$0.02",
      "English text-to-speech with Deepgram Aura-2: natural voices, up to 1000 chars per call. Returns base64 MP3.",
      ["text-to-speech", "tts", "voice", "audio", "speech"], { text: "Hello from your agent.", voice: "luna" },
      { properties: { text: { type: "string", description: "Up to 1000 chars" }, voice: { type: "string", description: "luna, asteria, athena, helena, hera, aurora, orion, apollo, arcas, atlas, hermes, zeus, draco, odysseus" } }, required: ["text"] },
      { model: "@cf/deepgram/aura-2-en", voice: "luna", mime: "audio/mpeg", audio_base64: "SUQzBAAAAAAA..." }),
    "POST /api/embed": post("$0.001",
      "Multilingual text embeddings (BGE-M3, 1024 dimensions) for up to 100 texts per call. For search, RAG and clustering.",
      ["embeddings", "vector", "rag", "semantic search", "bge-m3"], { text: ["first document", "second document"] },
      { properties: { text: { description: "A string or an array of up to 100 strings" } }, required: ["text"] },
      { model: "@cf/baai/bge-m3", dimensions: 1024, embeddings: [[0.012, -0.034]] }),
    "POST /api/chat": post("$0.004",
      "LLM chat completion with Llama 3.3 70B (fast): send messages or a prompt, up to 2048 output tokens.",
      ["llm", "chat", "llama", "text generation", "completion"], { prompt: "Summarize the benefits of x402 in two sentences.", max_tokens: 256 },
      { properties: { prompt: { type: "string" }, messages: { type: "array", description: "[{role, content}]" }, max_tokens: { type: "integer", description: "Up to 2048" }, temperature: { type: "number" } } },
      { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", response: "x402 lets agents pay per request...", usage: { prompt_tokens: 20, completion_tokens: 40 } }),
    "GET /api/audit": get("$0.02",
      "Website audit in one call: WCAG 2.2 accessibility issues (European Accessibility Act) with fixes and a score, SEO basics, security headers and tech stack.",
      ["accessibility", "wcag", "seo", "audit", "website"], { url: "example.com" }, urlSchema,
      { url: "https://example.com/", accessibility: { score: 85, issues: [{ severity: "critical", rule: "image-alt", wcag: "1.1.1", count: 3, fix: "Add alt text" }] }, seo: { title: "Example" }, security: { hsts: true }, tech: ["Shopify"] }),
    "GET /api/contacts": get("$0.01",
      "Company contact enrichment from a domain: emails (same-domain flagged), phones, social profiles, description and tech stack, read from the home, contact, about and legal pages.",
      ["enrichment", "contacts", "email", "company", "leads"], { url: "plausible.io" }, urlSchema,
      { domain: "plausible.io", name: "Plausible Analytics", emails: [{ email: "hello@plausible.io", sameDomain: true }], socials: { linkedin: "https://linkedin.com/company/plausible-analytics/" }, tech: ["Cloudflare"] }),
    "GET /api/hiring": get("$0.01",
      "Search the current Hacker News 'Who is hiring?' thread: companies hiring, filtered by keywords and remote, with contact emails and links.",
      ["jobs", "hiring", "hacker news", "leads", "remote"], { q: "python", remote: "1", limit: "20" },
      { properties: { q: { type: "string", description: "Keywords, all must match" }, remote: { type: "string", description: "1 = remote only" }, limit: { type: "string", description: "Max results, up to 100" } } },
      { thread: { title: "Ask HN: Who is hiring? (September 2026)" }, total: 38, results: [{ company: "Acme", headline: "Acme | Backend Engineer | REMOTE", emails: ["jobs@acme.com"], url: "https://news.ycombinator.com/item?id=1" }] }),
  };
}
