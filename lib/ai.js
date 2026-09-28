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
