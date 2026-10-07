// GET /api/uk-insolvency: UK company insolvency notices from our own nightly cache of The Gazette
// (https://gazette-cache.sitecheck-api.workers.dev). We never call thegazette.co.uk. Published under the Open
// Government Licence. Optional enrichment from Companies House when COMPANIES_HOUSE_API_KEY is set.
//
// CPU: the cache's answer is about 250 KB per day (1.7 MB for the whole 8-day window). Parsing all of it would blow the
// free plan's 10 ms CPU budget, so the raw text is scanned (indexOf) and only events that can match are JSON.parsed.
import { fetchJson, UA, ToolError, badInput, clampInt, isoDate } from "./upstream.js";

const CACHE = "https://gazette-cache.sitecheck-api.workers.dev/events";
const CH = "https://api.company-information.service.gov.uk";
const WINDOW_DAYS = 7;      // the cache holds today and the 7 days before it
const MAX_PARSE = 700;      // events parsed per call, whatever the filters
const MAX_ENRICH = 10;      // Companies House lookups per call
const START = '{"entry":{"noticeId"';
const SOURCE = "The Gazette (Open Government Licence v3.0) via the SiteCheck gazette cache";

export const ukToday = (now = new Date()) => now.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// Notice type words agents use, mapped to the notice type names in the cache.
const TYPE_ALIASES = [
  [/^administrat/, /administrator/], [/^liquidat/, /liquidator/], [/^petition/, /petition/], [/^wind/, /wind(ing)?[ -]?up/],
  [/^creditor/, /creditor/], [/^dividend/, /dividend/], [/^meeting/, /meeting/], [/^deemed/, /deemed/], [/^final/, /final meeting/],
];
export function typeMatcher(type) {
  const t = String(type).trim().toLowerCase();
  if (/^\d{4}$/.test(t)) return (code) => code === t;
  const alias = TYPE_ALIASES.find(([k]) => k.test(t));
  const re = alias ? alias[1] : new RegExp(t.replace(/[^a-z0-9 ]+/g, ".?").replace(/\s+/g, ".*"), "i");
  return (_, name) => re.test(String(name).toLowerCase());
}

// Start offsets of each event in the raw JSON text.
function eventStarts(text) {
  const starts = [];
  for (let i = text.indexOf(START); i !== -1; i = text.indexOf(START, i + 20)) starts.push(i);
  return starts;
}
const eventText = (text, starts, i) => text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] - 1 : text.lastIndexOf("}]") + 1);
// Index of the event that contains position `pos` (binary search over starts).
function eventAt(starts, pos) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
  return lo;
}

// Which events might match: every event that contains a needle, searched as typed, in UPPER CASE and in Title Case (the
// Gazette mostly writes names in capitals). If none of those hit, one slower lower-case pass catches odd casing.
const variants = (n) => [n, n.toUpperCase(), n.toLowerCase().replace(/(^|[\s&(-])([a-z])/g, (_, a, b) => a + b.toUpperCase())];
function candidates(text, starts, needles) {
  if (!needles.length) return starts.map((_, i) => i);
  const set = new Set();
  const scan = (hay, ns) => { for (const n of ns) for (let p = hay.indexOf(n); p !== -1; p = hay.indexOf(n, p + n.length)) if (p >= starts[0]) set.add(eventAt(starts, p)); };
  scan(text, [...new Set(needles.flatMap(variants))]);
  if (!set.size) { const lower = text.toLowerCase(); if (lower.length === text.length) scan(lower, needles.map((n) => n.toLowerCase())); else return starts.map((_, i) => i); }
  return [...set].sort((x, y) => x - y);
}

export function rowsOf(ev, { qText, qNumber, postcode }) {
  const { entry, detail } = ev;
  const companies = detail?.companies?.length ? detail.companies : [{ name: entry.title, number: null }];
  const out = [];
  for (const c of companies) {
    const name = c.name || entry.title || "";
    if (qNumber && String(c.number || "").toUpperCase() !== qNumber) continue;
    if (qText && !name.toLowerCase().includes(qText) && !String(c.tradingName || "").toLowerCase().includes(qText)) continue;
    if (postcode && !String(c.postcode || "").toUpperCase().replace(/\s/g, "").startsWith(postcode)) continue;
    out.push({
      company: name, companyNumber: c.number ?? null, noticeType: entry.noticeTypeName, noticeCode: entry.noticeCode,
      date: String(entry.publishedAt).slice(0, 10), publishedAt: entry.publishedAt,
      natureOfBusiness: c.natureOfBusiness ?? null, typeOfLiquidation: c.typeOfLiquidation ?? null, postcode: c.postcode ?? null,
      practitioners: (detail?.practitioners || []).filter((p) => p.firm || p.name).slice(0, 2).map((p) => p.firm || p.name),
      noticeId: entry.noticeId, link: `https://www.thegazette.co.uk/notice/${entry.noticeId}`,
    });
  }
  return out;
}

async function enrich(rows, key) {
  const numbers = [...new Set(rows.filter((r) => r.companyNumber).map((r) => r.companyNumber))].slice(0, MAX_ENRICH);
  const auth = `Basic ${btoa(`${key}:`)}`;
  const info = new Map();
  let failed = 0;
  await Promise.all(numbers.map(async (n) => {
    try {
      const c = await fetchJson(`${CH}/company/${encodeURIComponent(n)}`, { name: "Companies House", init: { headers: { authorization: auth } }, timeout: 6000, onStatus: (r) => (r.status === 404 ? { notFound: true } : undefined) });
      info.set(n, c?.notFound ? { found: false } : {
        found: true, name: c.company_name, status: c.company_status, type: c.type, incorporated: c.date_of_creation ?? null, sicCodes: c.sic_codes ?? [],
        registeredAddress: c.registered_office_address ? Object.values(c.registered_office_address).filter(Boolean).join(", ") : null,
        hasInsolvencyHistory: c.has_insolvency_history ?? null, link: `https://find-and-update.company-information.service.gov.uk/company/${n}`,
      });
    } catch { failed++; }
  }));
  for (const r of rows) if (info.has(r.companyNumber)) r.companiesHouse = info.get(r.companyNumber);
  return { enriched: info.size, failed, skipped: Math.max(0, new Set(rows.filter((r) => r.companyNumber).map((r) => r.companyNumber)).size - numbers.length) };
}

// One call to the cache. Returns the raw text, where each event starts, and the small header (dates, missing days).
async function readRange(from, to) {
  const res = await fetch(`${CACHE}?from=${from}&to=${to}`, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(10000) }).catch((e) => {
    throw new ToolError(503, `the Gazette cache ${e?.name === "TimeoutError" ? "timed out" : "could not be reached"}, you were not charged. Please retry later.`);
  });
  if (!res.ok) throw new ToolError(res.status === 429 || res.status >= 500 ? 503 : 502, `the Gazette cache answered HTTP ${res.status}, you were not charged. Please retry later.`);
  const text = await res.text();
  const unreadable = () => new ToolError(502, "the Gazette cache returned an unreadable answer, you were not charged. Please retry later.");
  const at = text.indexOf('"events":[');
  if (at < 0) throw unreadable();
  let meta;
  try { meta = JSON.parse(`${text.slice(0, at).replace(/,\s*$/, "")}}`); } catch { throw unreadable(); }
  let starts = eventStarts(text), events;
  if (Number.isFinite(meta.count) && starts.length !== meta.count) {
    // Unexpected layout: take the safe, slower route.
    try { events = JSON.parse(text).events; } catch { throw unreadable(); }
    starts = events.map((_, i) => i);
  }
  return { text, starts, events, meta };
}

export async function ukInsolvency(q, env = {}) {
  const limit = clampInt(q.limit, 50, 1, 200);
  const today = ukToday();
  const windowFrom = shift(today, -WINDOW_DAYS);
  let since = isoDate(q.since, "since") ?? shift(today, -7);
  const notes = [];
  if (since > today) throw badInput("since is in the future");
  if (since < windowFrom) { notes.push(`since clipped to ${windowFrom}: the cache holds the last ${WINDOW_DAYS + 1} UK days`); since = windowFrom; }
  const term = String(q.q ?? "").trim().slice(0, 100);
  // A company number is 8 characters: digits (zero-padded) or a 2-letter prefix (SC, NI, OC...) and 6 digits.
  const qNumber = /^[A-Za-z]{0,2}\d{4,8}$/.test(term) ? (/^\d+$/.test(term) ? term.padStart(8, "0") : term.toUpperCase()) : null;
  const qText = term && !qNumber ? term.toLowerCase() : null;
  const postcode = String(q.postcode ?? "").toUpperCase().replace(/\s/g, "");
  if (postcode && !/^[A-Z0-9]{1,7}$/.test(postcode)) throw badInput("postcode must be a postcode or a prefix, e.g. SW1A or M1 1AE");
  const typeOk = q.type ? typeMatcher(q.type) : null;

  const needles = [];
  if (postcode) {
    // the raw text writes postcodes with a space ("MK13 7QW"): try the prefix as typed and with the space after a 2-4 character outward code
    needles.push(`"postcode":"${postcode}`);
    for (let n = 2; n <= 4 && n < postcode.length; n++) needles.push(`"postcode":"${postcode.slice(0, n)} ${postcode.slice(n)}`);
  } else if (qText) needles.push(term);
  else if (qNumber) needles.push(`"number":"${qNumber}"`);

  // Needle searches read the whole window in one call. Others only need the newest notices: read two days at a time, newest first, until the limit is reached.
  const ranges = [];
  if (needles.length) ranges.push([since, today]);
  else for (let to = today; to >= since; to = shift(to, -2)) ranges.push([shift(to, -1) < since ? since : shift(to, -1), to]);

  let rows = [], parsed = 0, truncated = false;
  const meta = { dataTimestamp: null, coveredDays: [], missingDays: [], incompleteDays: [] };
  for (const [from, to] of ranges) {
    const part = await readRange(from, to);
    meta.dataTimestamp ??= part.meta.dataTimestamp;
    for (const k of ["coveredDays", "missingDays", "incompleteDays"]) meta[k] = [...new Set([...meta[k], ...(part.meta[k] || [])])].sort();
    let { text, starts, events } = part;
    const cand = events ? starts : candidates(text, starts, needles);
    for (const i of cand) {
      if (parsed >= MAX_PARSE) { truncated = true; break; }
      if (typeOk && !events) {
        const head = text.slice(starts[i], starts[i] + 700);
        const code = /"noticeCode":"(\d+)"/.exec(head)?.[1], name = /"noticeTypeName":"([^"]*)"/.exec(head)?.[1] ?? "";
        if (!typeOk(code, name)) continue;
      }
      parsed++;
      let ev;
      try { ev = events ? events[i] : JSON.parse(eventText(text, starts, i)); } catch { continue; }
      if (typeOk && events && !typeOk(ev.entry.noticeCode, ev.entry.noticeTypeName)) continue;
      rows.push(...rowsOf(ev, { qText, qNumber, postcode }));
      if (rows.length > limit) { truncated = true; break; }
    }
    if (truncated) break;
  }
  rows.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  const matched = rows.length;
  rows = rows.slice(0, limit);

  let enrichment;
  if (env.COMPANIES_HOUSE_API_KEY && rows.length) enrichment = await enrich(rows, env.COMPANIES_HOUSE_API_KEY);
  else if (!env.COMPANIES_HOUSE_API_KEY) notes.push("Companies House enrichment is off on this deployment (COMPANIES_HOUSE_API_KEY is not set).");
  if (meta.missingDays.length) notes.push(`The cache has no data for: ${meta.missingDays.join(", ")}${meta.missingDays.includes(today) ? " (today's notices are added overnight)" : ""}. Results do not cover those days.`);

  return {
    query: { since, until: today, q: term || null, postcode: postcode || null, type: q.type || null },
    returned: rows.length, ...(truncated ? { moreAvailable: true } : { total: matched }),
    results: rows,
    dataTimestamp: meta.dataTimestamp, coveredDays: meta.coveredDays, missingDays: meta.missingDays,
    ...(meta.incompleteDays.length ? { incompleteDays: meta.incompleteDays } : {}),
    ...(enrichment ? { companiesHouse: enrichment } : {}),
    ...(notes.length ? { notes } : {}), source: SOURCE,
  };
}
