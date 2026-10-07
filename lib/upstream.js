// Shared plumbing for the business and compliance tools: fetch with timeout and User-Agent,
// errors that carry an HTTP status (so a failed call is never settled), and a small Cache API wrapper.
export const UA = "SiteCheck/1.x (+https://api.sitecheck-api.workers.dev)";
const NOT_CHARGED = "you were not charged";

// A failure with an HTTP status. 400 = the caller's input, 502/503 = an upstream problem.
export class ToolError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const badInput = (message) => new ToolError(400, message);
export const upstreamDown = (name, why = "is unavailable") => new ToolError(503, `${name} ${why}, ${NOT_CHARGED}. Please retry later.`);

// Fetches and parses JSON. 204 returns null. Network errors, timeouts, 5xx and unparsable bodies become
// a 502/503 ToolError naming `name`; other statuses are handed to `onStatus(res)` (return a value, or throw), else 502.
export async function fetchJson(url, { name, init = {}, timeout = 9000, onStatus } = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, headers: { "user-agent": UA, accept: "application/json", ...init.headers }, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    throw new ToolError(timedOut ? 503 : 502, `${name} ${timedOut ? "timed out" : "could not be reached"}, ${NOT_CHARGED}. Please retry later.`);
  }
  if (res.status === 204) return null;
  if (!res.ok) {
    if (onStatus) { const out = await onStatus(res); if (out !== undefined) return out; }
    throw new ToolError(res.status === 429 || res.status >= 500 ? 503 : 502, `${name} answered HTTP ${res.status}, ${NOT_CHARGED}. Please retry later.`);
  }
  try { return await res.json(); }
  catch { throw new ToolError(502, `${name} returned an unreadable answer, ${NOT_CHARGED}. Please retry later.`); }
}

// Caches `produce()`'s JSON result in the Workers Cache API for `ttl` seconds. Without a Cache API
// (tests, local node) it just calls produce().
export async function cached(key, ttl, produce) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (!cache) return produce();
  const req = new Request(`https://cache.sitecheck.internal/${encodeURIComponent(key)}`);
  try {
    const hit = await cache.match(req);
    if (hit) return await hit.json();
  } catch { /* a broken cache must not break the tool */ }
  const value = await produce();
  try { await cache.put(req, new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` } })); } catch { /* ignore */ }
  return value;
}

export const clampInt = (v, def, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
export const isoDate = (v, what = "date") => {
  if (v === undefined || v === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw badInput(`${what} must be a date like 2026-09-01`);
  return m[0];
};
export const daysAgo = (n, now = Date.now()) => new Date(now - n * 86400000).toISOString().slice(0, 10);
