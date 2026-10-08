// AI endpoints on Cloudflare Workers AI (env.AI binding). Inputs are validated and capped
// so one paid call can't burn the daily allowance.
const bad = (msg) => { const e = new Error(msg); e.status = 400; throw e; };
const str = (v, name, max) => {
  if (typeof v !== "string" || !v.trim()) bad(`${name} is required`);
  if (v.length > max) bad(`${name} is too long (max ${max} chars)`);
  return v.trim();
};
const b64 = (buf) => {
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export const MODELS = {
  image: "@cf/black-forest-labs/flux-1-schnell",
  transcribe: "@cf/openai/whisper-large-v3-turbo",
  tts: "@cf/deepgram/aura-2-en",
  embed: "@cf/baai/bge-m3",
  chat: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  translate: "@cf/meta/llama-3.1-8b-instruct-fast",
};

export async function image(AI, body) {
  const prompt = str(body.prompt, "prompt", 2048);
  const steps = Math.min(Math.max(parseInt(body.steps) || 4, 1), 8);
  const r = await AI.run(MODELS.image, { prompt, steps });
  return { model: MODELS.image, mime: "image/jpeg", image_base64: r.image };
}

export async function transcribe(AI, body) {
  let audio;
  if (body.audio_base64) audio = str(body.audio_base64, "audio_base64", 34_000_000);
  else {
    const url = str(body.url, "url", 2048);
    if (!/^https:\/\//i.test(url)) bad("url must be https");
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; SiteCheckAPI/1.0)" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) bad(`could not fetch audio (${res.status})`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 25_000_000) bad("audio larger than 25 MB");
    audio = b64(buf);
  }
  const opts = { audio };
  if (body.language) opts.language = String(body.language).slice(0, 5);
  const r = await AI.run(MODELS.transcribe, opts);
  return { model: MODELS.transcribe, text: r.text, language: r.transcription_info?.language, duration: r.transcription_info?.duration, segments: (r.segments || []).map((s) => ({ start: s.start, end: s.end, text: s.text })) };
}

export const VOICES = ["luna", "asteria", "athena", "helena", "hera", "aurora", "orion", "apollo", "arcas", "atlas", "hermes", "zeus", "draco", "odysseus"];
export async function tts(AI, body) {
  const text = str(body.text, "text", 1000);
  const speaker = VOICES.includes(body.voice) ? body.voice : "luna";
  const r = await AI.run(MODELS.tts, { text, speaker, encoding: "mp3" });
  const buf = r instanceof ReadableStream ? await new Response(r).arrayBuffer() : r instanceof ArrayBuffer ? r : r?.audio ? null : await new Response(r).arrayBuffer();
  return { model: MODELS.tts, voice: speaker, mime: "audio/mpeg", audio_base64: buf ? b64(buf) : r.audio };
}

export async function embed(AI, body) {
  const input = Array.isArray(body.text) ? body.text : [body.text];
  if (!input.length || input.length > 100) bad("text must be a string or an array of up to 100 strings");
  input.forEach((t, i) => str(t, `text[${i}]`, 8000));
  const r = await AI.run(MODELS.embed, { text: input });
  return { model: MODELS.embed, dimensions: r.shape?.[1], embeddings: r.data };
}

export async function chat(AI, body) {
  let messages = body.messages;
  if (!messages && body.prompt) messages = [{ role: "user", content: str(body.prompt, "prompt", 24000) }];
  if (!Array.isArray(messages) || !messages.length || messages.length > 50) bad("messages (array) or prompt is required");
  let total = 0;
  for (const m of messages) {
    if (!["system", "user", "assistant"].includes(m?.role) || typeof m.content !== "string") bad("each message needs role and string content");
    total += m.content.length;
  }
  if (total > 24000) bad("messages too long (max 24000 chars total)");
  const max_tokens = Math.min(Math.max(parseInt(body.max_tokens) || 1024, 1), 2048);
  const r = await AI.run(MODELS.chat, { messages, max_tokens, temperature: typeof body.temperature === "number" ? body.temperature : 0.6 });
  return { model: MODELS.chat, response: r.response, usage: r.usage };
}

// Translation with Llama 3.1 8B (instruct, fast): better than M2M-100 on short mixed texts and keeps formatting.
// Language codes (ISO 639-1, e.g. "tr") or English names; the source is detected when not given.
export const TRANSLATE_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const langName = (code) => { try { return /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/i.test(code) ? new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code : code; } catch { return code; } };
export async function translate(AI, body) {
  const text = str(body.text, "text", 6000);
  const targetCode = str(body.target ?? body.target_lang, "target", 30).toLowerCase();
  const sourceCode = typeof (body.source ?? body.source_lang) === "string" && (body.source ?? body.source_lang).trim() ? (body.source ?? body.source_lang).trim().toLowerCase() : null;
  const target = langName(targetCode), source = sourceCode ? langName(sourceCode) : null;
  const parts = [];
  let cur = "";
  for (const s of text.split(/(?<=\n\n)/)) { if ((cur + s).length > 1500 && cur) { parts.push(cur); cur = s; } else cur += s; }
  if (cur) parts.push(cur);
  const out = [];
  for (const p of parts) {
    const r = await AI.run(TRANSLATE_MODEL, { max_tokens: 2048, temperature: 0.1, messages: [
      { role: "system", content: `You are a translation engine. Translate the user's text ${source ? `from ${source} ` : ""}into ${target}. Translate everything, including short phrases and product terms that have a common ${target} equivalent; keep names, code, URLs, numbers and line breaks. Output only the translation, with no notes or quotes.` },
      { role: "user", content: p },
    ] });
    out.push(String(r.response ?? "").trim());
  }
  return { model: TRANSLATE_MODEL, source: sourceCode ?? "auto", target: targetCode, translated_text: out.join("\n\n").trim(), chunks: parts.length };
}
