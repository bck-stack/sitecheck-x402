// Panta API client (https://docs.panta.market). Panta runs USDC prediction markets on Solana: it quotes,
// builds unsigned transactions and attributes trades. It never holds user keys, and neither does SiteCheck.
// Switched on by the PANTA_API_KEY Worker secret; PANTA_BASE_URL (var) is optional. Sources: docs/PANTA.md.
//   - Every request sends the key in X-Api-Key (Panta rejects keys in the query string).
//   - Every path ends with "/": Panta requires it and answers 301 without it.
//   - Errors come back as { code, message, field?, fields? }; code is what to switch on.

export const PANTA_URL = "https://live-api.panta.market/api/v1";
export const DISCLAIMER = "Information only, not financial advice.";
// Panta's Terms of Use (section 6) require exactly this wording, linked to panta.market where links work.
export const POWERED_BY = { text: "Powered by Panta", url: "https://panta.market" };

const TIMEOUT_MS = { read: 8000, quote: 10000, build: 12000, report: 10000 };
const LOCAL = /^(localhost|127\.0\.0\.1)$/;

// { enabled: true, baseUrl, key } or { enabled: false, reason } (shown on /health, never with the key).
export function pantaConfig(env = {}) {
  const key = String(env.PANTA_API_KEY ?? "").trim();
  const raw = String(env.PANTA_BASE_URL ?? "").trim() || PANTA_URL;
  if (!key) return { enabled: false, reason: "PANTA_API_KEY secret is not set" };
  let url;
  try { url = new URL(raw); } catch { return { enabled: false, reason: "PANTA_BASE_URL is not a valid URL" }; }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL.test(url.hostname))) {
    return { enabled: false, reason: "PANTA_BASE_URL must be an https URL" };
  }
  return { enabled: true, baseUrl: url.href.replace(/\/+$/, ""), key };
}

// status: the HTTP status Panta answered (or 502/504 for network trouble); code: Panta's error code.
export class PantaError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code }, extra);
  }
}

export function pantaClient({ baseUrl, key }) {
  async function call(method, path, { query, body, timeout = TIMEOUT_MS.read } = {}) {
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const headers = { Accept: "application/json", "X-Api-Key": key };
    if (body) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetch(url.href, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      console.error(`[panta] ${method} ${path} ${timedOut ? "timed out" : `failed: ${e?.message || e}`}`);
      throw timedOut
        ? new PantaError(504, "TIMEOUT", `Panta did not answer within ${timeout / 1000} s`)
        : new PantaError(502, "UNREACHABLE", "Panta could not be reached");
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON: handled below */ }
    if (res.ok && data && typeof data === "object") return data;

    const code = typeof data?.code === "string" ? data.code : res.ok ? "BAD_RESPONSE" : `HTTP_${res.status}`;
    const message = typeof data?.message === "string" && data.message ? data.message
      : res.ok ? "Panta answered with something other than JSON" : `Panta answered HTTP ${res.status}`;
    // Our own credentials, rate limit or Panta being down are worth a log line; a buyer's bad input is not.
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500 || res.ok) {
      console.error(`[panta] ${method} ${path} answered ${res.status} ${code}`);
    }
    throw new PantaError(res.ok ? 502 : res.status, code, message.slice(0, 300), {
      field: data?.field, fields: data?.fields, retryAfter: res.headers.get("retry-after"),
    });
  }

  const id = (s) => encodeURIComponent(s);
  return {
    // Catalog (read family, 120 requests / 60 s per account by default).
    listMarkets: ({ status, category, cursor, limit = 50 } = {}) => call("GET", "/markets/", { query: { status, category, cursor, limit } }),
    getMarket: (marketId) => call("GET", `/markets/${id(marketId)}/`),
    marketTrades: (marketId, limit = 50) => call("GET", `/markets/${id(marketId)}/trades/`, { query: { limit } }),
    // Primary buy: quote (~90 s session), build (unsigned instructions, ~120 s order session), then the
    // buyer signs and broadcasts, and the signature goes back to Panta through submit and the trade report.
    quoteBuy: ({ wallet, marketId, side, amountUsdc }) => call("POST", "/primaryorderquote/", { body: { wallet, marketId, side, amountUsdc }, timeout: TIMEOUT_MS.quote }),
    buildBuy: ({ quoteId, wallet, maxSlippageBps }) => call("POST", "/primaryorderbuild/", { body: { quoteId, wallet, maxSlippageBps }, timeout: TIMEOUT_MS.build }),
    submitOrder: ({ orderId, signature, wallet }) => call("POST", "/primaryordersubmit/", { body: { orderId, signature, wallet }, timeout: TIMEOUT_MS.report }),
    reportTrade: (body) => call("POST", "/trades/", { body, timeout: TIMEOUT_MS.report }),
  };
}

// A small time-based cache for resolved values only. A Worker request can't await a promise another
// request started (it hangs), so in-flight requests are never shared; each caller fetches on a miss.
export function ttlCache(max = 500) {
  const entries = new Map();
  return {
    get(key) {
      const e = entries.get(key);
      if (!e) return undefined;
      if (e.expires > Date.now()) return e.value;
      entries.delete(key);
      return undefined;
    },
    set(key, value, ttlMs) {
      entries.delete(key);
      entries.set(key, { value, expires: Date.now() + ttlMs });
      if (entries.size > max) entries.delete(entries.keys().next().value);
      return value;
    },
  };
}
