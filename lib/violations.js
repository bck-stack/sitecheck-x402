// GET /api/violations: US enforcement cases by company / state / date.
//   OSHA: DOL Data API v4 (needs the DOL_API_KEY secret). Inspections by establishment name, then the penalties of
//         those inspections from the violation dataset, in URL-sized chunks (DOL answers 403 above ~2,000 characters).
//   EPA:  ECHO web services (no key). Facilities by name/state that have formal actions, then their enforcement cases.
// Subrequests per call stay far below Workers' limit of 50: see MAX_CHUNKS and MAX_FACILITIES.
import { fetchJson, cached, badInput, ToolError, clampInt, isoDate, daysAgo } from "./upstream.js";

const DOL = "https://apiprod.dol.gov/v4/get/OSHA";
const ECHO = "https://echodata.epa.gov/echo";
const MAX_URL = 1800;        // DOL returns HTTP 403 for URLs longer than about 2,000 characters
const MAX_CHUNKS = 4;        // violation lookups per call
const MAX_FACILITIES = 5;    // EPA facilities whose cases are fetched per call
const TTL = 900;
const SOURCES = ["osha", "epa"];

const money = (s) => { const n = Number(String(s ?? "").replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : 0; };
const usDate = (s) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || ""); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
const upper = (s) => String(s ?? "").trim();
const rowsOf = (res) => (Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []);
const filter = (...f) => JSON.stringify(f.length === 1 ? f[0] : { and: f });
const cond = (field, operator, value) => ({ field, operator, value });

export function dolUrl(dataset, key, params) {
  const qs = Object.entries({ "X-API-KEY": key, ...params }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${DOL}/${dataset}/json?${qs}`;
}

// Splits activity numbers into groups whose violation URL stays under MAX_URL.
export function chunkIds(ids, key) {
  const chunks = [];
  let cur = [];
  for (const id of ids) {
    const next = [...cur, id];
    const url = dolUrl("violation", key, { limit: 200, filter_object: filter(cond("activity_nr", "in", next)) });
    if (url.length > MAX_URL && cur.length) { chunks.push(cur); cur = [id]; } else cur = next;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function osha({ company, state, since, minPenalty, limit }, key) {
  const f = [cond("open_date", "gt", since)];
  // DOL stores establishment names in upper case and "like" is case-sensitive and needs % wildcards.
  if (company) f.push(cond("estab_name", "like", `%${company.toUpperCase().replace(/[%_]/g, "")}%`));
  if (state) f.push(cond("site_state", "eq", state));
  const want = Math.min(100, minPenalty ? limit * 3 : limit);
  const insp = rowsOf(await fetchJson(dolUrl("inspection", key, { limit: want, sort: "desc", sort_by: "open_date", filter_object: filter(...f) }), { name: "DOL OSHA API" }));
  const notes = [];
  if (!insp.length) return { rows: [], notes };
  const ids = insp.map((r) => r.activity_nr).filter(Boolean);
  const chunks = chunkIds(ids, key);
  if (chunks.length > MAX_CHUNKS) notes.push(`OSHA penalties were looked up for the ${chunks.slice(0, MAX_CHUNKS).flat().length} most recent of ${ids.length} inspections`);
  const penalties = new Map(), kinds = new Map();
  const answers = await Promise.all(chunks.slice(0, MAX_CHUNKS).map((c) => fetchJson(dolUrl("violation", key, { limit: 200, filter_object: filter(cond("activity_nr", "in", c)) }), { name: "DOL OSHA API" })));
  for (const v of answers.flatMap(rowsOf)) {
    const k = String(v.activity_nr);
    penalties.set(k, (penalties.get(k) || 0) + money(v.current_penalty ?? v.initial_penalty));
    const t = { S: "Serious", W: "Willful", R: "Repeat", O: "Other", U: "Unclassified", F: "Failure to abate" }[v.viol_type] || v.viol_type;
    if (t) kinds.set(k, [...new Set([...(kinds.get(k) || []), t])]);
  }
  const looked = new Set(chunks.slice(0, MAX_CHUNKS).flat().map(String));
  const rows = insp.map((r) => {
    const id = String(r.activity_nr);
    const penalty = looked.has(id) ? Math.round((penalties.get(id) || 0) * 100) / 100 : null;
    return {
      source: "osha", id, company: r.estab_name ?? null, state: r.site_state ?? null, city: r.site_city ?? null,
      date: String(r.open_date || "").slice(0, 10) || null, penalty, currency: "USD",
      type: ["OSHA inspection", r.insp_type && `type ${r.insp_type}`, ...(kinds.get(id) || []).map((k) => `${k} violation(s)`)].filter(Boolean).join(", "),
      closed: String(r.close_case_date || "").slice(0, 10) || null,
      link: `https://www.osha.gov/ords/imis/establishment.inspection_detail?id=${id}`,
    };
  });
  return { rows, notes };
}

const echoJson = async (path, params, name = "EPA ECHO") => {
  const qs = Object.entries({ output: "JSON", ...params }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const res = await fetchJson(`${ECHO}/${path}?${qs}`, { name, timeout: 9000 });
  const err = res?.Results?.Error?.ErrorMessage;
  if (err) {
    if (/more selective|Queryset Limit/i.test(err)) throw badInput("EPA ECHO says the search is too broad: add company= (a name or part of it) and/or state=. You were not charged.");
    throw new ToolError(502, `EPA ECHO error: ${String(err).slice(0, 150)}. You were not charged.`);
  }
  return res?.Results ?? {};
};

async function epa({ company, state, since, minPenalty, limit }) {
  const params = { ...(company ? { p_fn: company } : {}), ...(state ? { p_st: state } : {}) };
  const qid = (await echoJson("echo_rest_services.get_facilities", params)).QueryID;
  if (!qid) return { rows: [], notes: [] };
  const facs = (await echoJson("echo_rest_services.get_qid", { qid, pageno: 1 })).Facilities || [];
  const withActions = facs
    .filter((f) => Number(f.FacFormalActionCount) > 0 || money(f.FacTotalPenalties) > 0)
    .sort((a, b) => money(b.FacTotalPenalties) - money(a.FacTotalPenalties));
  const notes = [];
  if (withActions.length > MAX_FACILITIES) notes.push(`EPA: cases were fetched for the ${MAX_FACILITIES} facilities with the highest penalties out of ${withActions.length} matches; narrow with company= or state=`);
  const perFacility = await Promise.all(withActions.slice(0, MAX_FACILITIES).map(async (f) => {
    const q = (await echoJson("case_rest_services.get_cases", { p_facility_id: f.RegistryID })).QueryID;
    if (!q) return [];
    const cases = (await echoJson("case_rest_services.get_qid", { qid: q, pageno: 1 })).Cases || [];
    return cases.map((c) => ({
      source: "epa", id: c.CaseNumber, company: c.CaseName ?? f.FacName, facility: f.FacName ?? null, state: f.FacState ?? null, city: f.FacCity ?? null,
      date: usDate(c.DateFiled) ?? usDate(c.SettlementDate), penalty: money(c.FedPenalty) + money(c.StateLocPenaltyAmt), currency: "USD",
      type: [c.CaseCategoryDesc, c.PrimaryLaw && `${c.PrimaryLaw}${c.PrimarySection ? ` §${c.PrimarySection}` : ""}`, c.EnfOutcome].filter(Boolean).join(", "),
      status: c.CaseStatusDesc ?? null, settled: usDate(c.SettlementDate), registryId: f.RegistryID,
      link: `https://echo.epa.gov/enforcement-case-report?id=${encodeURIComponent(c.CaseNumber)}`,
    }));
  }));
  const rows = perFacility.flat().filter((r) => (!r.date || r.date >= since) && r.penalty >= minPenalty);
  return { rows, notes };
}

export async function violations(q, env = {}) {
  const company = upper(q.company).slice(0, 100);
  const state = upper(q.state).toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(state)) throw badInput("state must be a 2-letter US state code, e.g. TX");
  if (!company && !state) throw badInput("company and/or state is required, e.g. company=Tesla&state=CA");
  const sources = [...new Set(String(q.source || "osha,epa").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean))];
  if (!sources.length || sources.some((s) => !SOURCES.includes(s))) throw badInput("source must be osha, epa or osha,epa");
  const since = isoDate(q.since, "since") ?? daysAgo(365);
  let minPenalty = 0;
  if (q.minPenalty !== undefined && q.minPenalty !== "") {
    minPenalty = Number(q.minPenalty);
    if (!Number.isFinite(minPenalty) || minPenalty < 0) throw badInput("minPenalty must be a number of US dollars, e.g. 10000");
  }
  const limit = clampInt(q.limit, 20, 1, 100);
  const args = { company, state, since, minPenalty, limit };
  const key = env.DOL_API_KEY;
  const notes = [];
  const tasks = [], used = [];
  if (sources.includes("osha")) {
    if (!key) notes.push("OSHA is off on this deployment (DOL_API_KEY is not set): only EPA results are included.");
    else { used.push("osha"); tasks.push(cached(`viol-osha-${JSON.stringify(args)}`, TTL, () => osha(args, key))); }
  }
  if (sources.includes("epa") && !company) notes.push("EPA was skipped: its search needs company=.");
  else if (sources.includes("epa")) { used.push("epa"); tasks.push(cached(`viol-epa-${JSON.stringify(args)}`, TTL, () => epa(args))); }
  if (!tasks.length) {
    if (!key && sources.includes("osha")) throw new ToolError(503, "OSHA is off on this deployment (DOL_API_KEY is not set) and nothing else was requested. You were not charged.");
    throw badInput("EPA needs company=. Add a company name. You were not charged.");
  }
  const parts = await Promise.all(tasks);
  let rows = parts.flatMap((p) => p.rows);
  for (const p of parts) notes.push(...p.notes);
  if (minPenalty) rows = rows.filter((r) => (r.penalty ?? 0) >= minPenalty);
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    query: { company: company || null, state: state || null, since, minPenalty: minPenalty || null, sources: used },
    total: rows.length, returned: Math.min(rows.length, limit), results: rows.slice(0, limit),
    ...(notes.length ? { notes } : {}),
    sources: [...(used.includes("osha") ? ["US Department of Labor OSHA enforcement data (https://enforcedata.dol.gov)"] : []), ...(used.includes("epa") ? ["US EPA ECHO (https://echo.epa.gov)"] : [])],
    caveat: "Public enforcement records, matched by name: they show inspections and cases, not guilt or current compliance. Check the record link before relying on a row.",
  };
}
