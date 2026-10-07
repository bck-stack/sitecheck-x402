// GET /api/recalls: US product recalls from openFDA enforcement reports (food, drug, device) and CPSC, one schema.
// Both sources are free and keyless. Any failing source fails the whole call (503), so nothing partial is charged.
import { fetchJson, cached, badInput, clampInt, isoDate, daysAgo } from "./upstream.js";

const FDA = "https://api.fda.gov";
const CPSC = "https://www.saferproducts.gov/RestWebServices/Recall";
const FDA_KINDS = ["food", "drug", "device"];
const TTL = 1800;
const MAX_DAYS = 365;          // keeps the CPSC date-range pull (about 5 KB/day) small enough to parse within the CPU budget
const CPSC_UNFILTERED_DAYS = 120;
const SEVERITY = { "class i": "high", "class ii": "medium", "class iii": "low", i: "high", ii: "medium", iii: "low", high: "high", medium: "medium", low: "low" };
const CLASS_OF = { high: "Class I", medium: "Class II", low: "Class III" };
export const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI".split(" "));

// FDA enforcement class to severity; CPSC has no class, so its severity is read from the hazard text.
const HIGH = /death|fatal|serious injur|chok|strangl|suffocat|drown|ingest|\bfires?\b|fire hazard|\bburns?\b|electrocut|explo|amputat|entrap|poison|\blead\b|salmonella|listeria|e\. ?coli|botulism|undeclared|allergen|overdose/i;
const MEDIUM = /injur|lacerat|\bcut|shock|fall|tip.?over|pinch|crush|impact|laceration|hazard|contaminat|sub.?potent|mislabel/i;
export const cpscSeverity = (text) => (HIGH.test(text) ? "high" : MEDIUM.test(text) ? "medium" : "low");

const word = (s) => String(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean).slice(0, 6);
const ymd = (iso) => iso.replace(/-/g, "");
const fdaDate = (s) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null);
const trim = (s, n = 400) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export function fdaStates(text) {
  const t = String(text ?? "");
  const states = [...new Set((t.match(/\b[A-Z]{2}\b/g) || []).filter((s) => STATES.has(s)))];
  return { states, nationwide: /nationwide|nation-wide|all states|\bUSA\b|United States|worldwide/i.test(t) };
}

export function fdaRow(kind, r) {
  const sev = SEVERITY[String(r.classification || "").toLowerCase()] ?? null;
  const dist = fdaStates(r.distribution_pattern);
  return {
    source: "fda", category: kind, id: r.recall_number, date: fdaDate(r.report_date) ?? fdaDate(r.recall_initiation_date),
    initiated: fdaDate(r.recall_initiation_date), product: trim(r.product_description), firm: r.recalling_firm ?? null,
    reason: trim(r.reason_for_recall), classification: r.classification ?? null, severity: sev, status: r.status ?? null,
    distribution: trim(r.distribution_pattern, 300) || null, states: dist.states, nationwide: dist.nationwide,
    firmLocation: [r.city, r.state].filter(Boolean).join(", ") || null,
    link: r.event_id ? `https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event=${r.event_id}` : "https://www.accessdata.fda.gov/scripts/ires/",
  };
}

export function cpscRow(r) {
  const hazards = (r.Hazards || []).map((h) => trim(h.Name, 300)).filter(Boolean);
  const firms = [...(r.Manufacturers || []), ...(r.Importers || []), ...(r.Distributors || [])].map((x) => x.Name).filter(Boolean);
  const sold = (r.Retailers || []).map((x) => x.Name).filter(Boolean).join(" ");
  const dist = fdaStates(sold);
  return {
    source: "cpsc", category: (r.Products?.[0]?.Type) || "consumer product", id: r.RecallNumber, date: String(r.RecallDate || "").slice(0, 10) || null,
    product: trim((r.Products || []).map((p) => p.Name).filter(Boolean).join("; ") || r.Title), firm: firms[0] ? trim(firms[0], 200) : null,
    reason: hazards[0] || trim(r.Title), classification: null, severity: cpscSeverity(hazards.join(" ") + " " + (r.Title || "")),
    hazards, remedy: (r.RemedyOptions || []).map((o) => o.Option).filter(Boolean), units: r.Products?.[0]?.NumberOfUnits || null,
    injuries: (r.Injuries || []).map((i) => trim(i.Name, 200)).filter(Boolean),
    distribution: trim(sold, 300) || null, states: dist.states, nationwide: dist.nationwide,
    link: r.URL || `https://www.cpsc.gov/Recalls`,
  };
}

async function queryFda(kind, { q, since, until, severity, limit }) {
  const terms = [`report_date:[${ymd(since)}+TO+${ymd(until)}]`];
  const w = word(q || "");
  if (w.length) { const m = `(${w.map(encodeURIComponent).join("+AND+")})`; terms.push(`(product_description:${m}+OR+recalling_firm:${m})`); }
  if (severity) terms.push(`classification:%22${encodeURIComponent(CLASS_OF[severity])}%22`);
  const url = `${FDA}/${kind}/enforcement.json?search=${terms.join("+AND+")}&sort=report_date:desc&limit=${limit}`;
  const res = await fetchJson(url, { name: `openFDA (${kind})`, onStatus: (r) => (r.status === 404 ? { results: [] } : undefined) });
  return (res?.results || []).map((r) => fdaRow(kind, r));
}

async function queryCpsc({ q, since, until, limit }) {
  const base = `${CPSC}?format=json&RecallDateStart=${since}&RecallDateEnd=${until}`;
  const w = word(q || "").join(" ");
  const urls = w ? ["ProductName", "RecallTitle", "RecallDescription"].map((f) => `${base}&${f}=${encodeURIComponent(w)}`) : [base];
  const lists = await Promise.all(urls.map((u) => fetchJson(u, { name: "CPSC SaferProducts", timeout: 9000 })));
  const seen = new Map();
  for (const list of lists) for (const r of Array.isArray(list) ? list : []) seen.set(r.RecallID, r);
  return [...seen.values()].sort((a, b) => String(b.RecallDate).localeCompare(String(a.RecallDate))).slice(0, Math.max(limit, 20) * 2).map(cpscRow);
}

export async function recalls(q) {
  const limit = clampInt(q.limit, 20, 1, 100);
  const sources = [...new Set(String(q.source || "fda,cpsc").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean))];
  if (!sources.length || sources.some((s) => s !== "fda" && s !== "cpsc")) throw badInput("source must be fda, cpsc or fda,cpsc");
  let severity = null;
  if (q.classification) {
    severity = SEVERITY[String(q.classification).toLowerCase().replace(/^class\s+/, "class ").trim()] ?? SEVERITY[String(q.classification).toLowerCase().trim()];
    if (!severity) throw badInput("classification must be Class I, Class II, Class III, or high, medium, low");
  }
  const today = daysAgo(0);
  let since = isoDate(q.since, "since") ?? daysAgo(30);
  if (since > today) throw badInput("since is in the future");
  const notes = [];
  if (since < daysAgo(MAX_DAYS)) { since = daysAgo(MAX_DAYS); notes.push(`since clipped to ${since} (at most ${MAX_DAYS} days back)`); }
  const keyword = String(q.q ?? "").trim().slice(0, 100);
  let cpscSince = since;
  if (sources.includes("cpsc") && !keyword && since < daysAgo(CPSC_UNFILTERED_DAYS)) { cpscSince = daysAgo(CPSC_UNFILTERED_DAYS); notes.push(`CPSC without a keyword covers at most ${CPSC_UNFILTERED_DAYS} days (from ${cpscSince}); add q= to go further back`); }

  const base = { q: keyword, until: today, severity, limit };
  const tasks = [];
  if (sources.includes("fda")) for (const kind of FDA_KINDS) tasks.push(cached(`recalls-fda-${kind}-${keyword}-${since}-${severity}-${limit}-${today}`, TTL, () => queryFda(kind, { ...base, since })));
  if (sources.includes("cpsc")) tasks.push(cached(`recalls-cpsc-${keyword}-${cpscSince}-${limit}-${today}`, TTL, () => queryCpsc({ ...base, since: cpscSince })));
  let rows = (await Promise.all(tasks)).flat();
  if (severity) rows = rows.filter((r) => r.severity === severity);
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const total = rows.length;
  return {
    query: { q: keyword || null, source: sources, since, classification: severity ? `${CLASS_OF[severity]} / ${severity}` : null },
    total, returned: Math.min(total, limit), results: rows.slice(0, limit),
    ...(notes.length ? { notes } : {}),
    severityNote: "FDA severity maps Class I/II/III to high/medium/low. CPSC does not classify recalls: its severity is derived from the hazard text.",
    sources: ["openFDA enforcement reports (https://open.fda.gov)", "CPSC SaferProducts.gov Recall API (https://www.saferproducts.gov)"].filter((_, i) => sources.includes(i ? "cpsc" : "fda")),
  };
}
