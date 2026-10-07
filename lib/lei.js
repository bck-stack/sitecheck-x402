// GET /api/lei: GLEIF (Global LEI Foundation) lookup by LEI or company name, with parents and children.
// GLEIF data is CC0. No key. A record can be found without parents: we then report the "reporting exception".
import { fetchJson, cached, badInput, ToolError } from "./upstream.js";

const API = "https://api.gleif.org/api/v1";
const JSONAPI = { accept: "application/vnd.api+json" };
const FRESH = 3600;      // GLEIF publishes one golden copy per day; an hour is safe
const SEARCH_SIZE = 20;  // candidates fetched for name matching, ranked locally
const NAME = "GLEIF";

export const looksLikeLei = (s) => /^[A-Z0-9]{18}[0-9]{2}$/.test(s);
// ISO 17442: the LEI, letters turned to numbers, leaves remainder 1 modulo 97.
export const leiChecksumOk = (lei) => {
  let r = 0;
  for (const ch of lei.replace(/[A-Z]/g, (c) => c.charCodeAt(0) - 55)) r = (r * 10 + +ch) % 97;
  return r === 1;
};

const get = (path, opts = {}) => fetchJson(`${API}/${path}`, { name: NAME, init: { headers: JSONAPI }, onStatus: opts.onStatus });
const notFound = (r) => (r.status === 404 ? null : undefined);
const page = (n) => `page%5Bsize%5D=${n}`;

const addr = (a) => a && {
  lines: (a.addressLines || []).filter(Boolean), city: a.city ?? null, region: a.region ?? null, postalCode: a.postalCode ?? null, country: a.country ?? null,
};
const day = (d) => (d ? String(d).slice(0, 10) : null);
const brief = (rec) => rec && ({ lei: rec.id, name: rec.attributes?.entity?.legalName?.name ?? null, jurisdiction: rec.attributes?.entity?.jurisdiction ?? null, country: rec.attributes?.entity?.legalAddress?.country ?? null, status: rec.attributes?.entity?.status ?? null });

function shape(rec) {
  const a = rec.attributes, e = a.entity, r = a.registration;
  return {
    lei: a.lei, legalName: e.legalName?.name ?? null,
    otherNames: (e.otherNames || []).slice(0, 5).map((n) => ({ name: n.name, type: n.type })),
    status: e.status, jurisdiction: e.jurisdiction ?? null, category: e.category ?? null,
    legalForm: e.legalForm?.id ?? e.legalForm?.other ?? null,
    registeredAs: e.registeredAs ?? null, registeredAt: e.registeredAt?.id ?? null,
    legalAddress: addr(e.legalAddress), headquartersAddress: addr(e.headquartersAddress),
    registration: {
      status: r.status, initialRegistrationDate: day(r.initialRegistrationDate), lastUpdateDate: day(r.lastUpdateDate), nextRenewalDate: day(r.nextRenewalDate),
      managingLou: r.managingLou ?? null, corroborationLevel: r.corroborationLevel ?? null,
    },
    successor: e.successorEntities?.[0] ?? (e.successorEntity?.lei ? e.successorEntity : null) ?? undefined,
  };
}

const norm = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const STOP = new Set(["the", "and", "of", "inc", "incorporated", "llc", "ltd", "limited", "plc", "public", "corp", "corporation", "co", "company", "gmbh", "ag", "aktiengesellschaft", "sa", "se", "bv", "nv", "oy", "ab", "aktiebolag", "as", "lp", "llp", "spa", "srl", "kg"]);
// Registered names often spell the legal form out ("Siemens Aktiengesellschaft"), and GLEIF's search does not
// treat "AG" and "Aktiengesellschaft" as the same, so a query ending in a short form is also searched in full.
const LONG_FORM = { ag: "Aktiengesellschaft", inc: "Incorporated", corp: "Corporation", ltd: "Limited", plc: "Public Limited Company", ab: "Aktiebolag" };
const longForm = (q) => { const m = q.trim().match(/^(.*\S)\s+([A-Za-z]+)\.?$/); const l = m && LONG_FORM[m[2].toLowerCase()]; return l ? `${m[1]} ${l}` : null; };
const tokens = (s) => norm(s).split(" ").filter((t) => t && !STOP.has(t));
// Similarity 0..1 between the query and a legal name; active entities get a small bonus.
export function score(query, name, status) {
  const nq = norm(query), nn = norm(name);
  let s;
  if (nq === nn) s = 1;
  else {
    const a = new Set(tokens(query)), b = new Set(tokens(name));
    const inter = [...a].filter((t) => b.has(t)).length;
    const jac = a.size && b.size ? inter / (a.size + b.size - inter) : 0;
    s = Math.min(0.95, jac * 0.85 + (nn.startsWith(nq) ? 0.1 : 0));
  }
  return Math.round(Math.min(1, s + (status === "ACTIVE" ? 0.02 : 0)) * 1000) / 1000;
}

async function relation(lei, kind) {
  const rec = await get(`lei-records/${lei}/${kind}-parent`, { onStatus: notFound });
  if (rec?.data) return { relationship: "reported", ...brief(rec.data) };
  const ex = await get(`lei-records/${lei}/${kind}-parent-reporting-exception`, { onStatus: notFound });
  if (ex?.data) return { relationship: "exception", reason: ex.data.attributes?.reason ?? null, category: ex.data.attributes?.category ?? null, reference: ex.data.attributes?.reference ?? null };
  return { relationship: "none-reported" };
}
const parentLine = (p) => (p.relationship === "reported" ? `${p.name}${p.country ? ` (${p.country})` : ""}` : p.relationship === "exception" ? `none reported (${String(p.reason || "exception").toLowerCase().replace(/_/g, " ")})` : "none reported");

export function kycSummary(entity, ultimate) {
  const parts = [{ ACTIVE: "Active", INACTIVE: "Inactive", NULL: "Status unknown" }[entity.status] || entity.status];
  const r = entity.registration;
  const now = new Date().toISOString().slice(0, 10);
  if (r.status === "LAPSED") parts.push(`registration lapsed${r.nextRenewalDate ? ` ${r.nextRenewalDate}` : ""}`);
  else if (r.status === "ISSUED") parts.push(r.nextRenewalDate && r.nextRenewalDate < now ? `renewal overdue since ${r.nextRenewalDate}` : `registration issued, renewal due ${r.nextRenewalDate}`);
  else parts.push(`registration ${String(r.status).toLowerCase().replace(/_/g, " ")}`);
  if (entity.jurisdiction) parts.push(`jurisdiction ${entity.jurisdiction}`);
  parts.push(`ultimate parent: ${parentLine(ultimate)}`);
  return parts.join(", ");
}

async function loadRecord(lei) {
  const rec = await cached(`gleif-${lei}`, FRESH, () => get(`lei-records/${lei}`, { onStatus: notFound }));
  if (!rec?.data) throw new ToolError(404, `no GLEIF record for LEI ${lei}. You were not charged.`);
  return rec.data;
}

export async function lei(q) {
  const query = String(q.q ?? q.lei ?? q.name ?? "").trim();
  if (!query) throw badInput("q is required: a 20-character LEI or a company name, e.g. q=529900T8BM49AURSDO55");
  if (query.length > 200) throw badInput("q is too long");

  let rec, matchScore, alternatives = [], matchedBy = "lei";
  const upper = query.toUpperCase().replace(/\s+/g, "");
  if (looksLikeLei(upper)) {
    if (!leiChecksumOk(upper)) throw badInput(`${upper} is not a valid LEI (ISO 17442 checksum fails). No lookup was made and you were not charged.`);
    rec = await loadRecord(upper);
  } else {
    matchedBy = "name";
    // GLEIF's fulltext search can miss the exact company (e.g. "Apple Inc" does not return Apple Inc.), so the
    // legal-name filter runs alongside it and both result sets are ranked together.
    const res = await cached(`gleif-search-${norm(query)}`, FRESH, async () => {
      const long = longForm(query);
      const answers = await Promise.all([
        ...(long ? [get(`lei-records?filter%5Bentity.legalName%5D=${encodeURIComponent(long)}&${page(SEARCH_SIZE)}`)] : []),
        get(`lei-records?filter%5Bentity.legalName%5D=${encodeURIComponent(query)}&${page(SEARCH_SIZE)}`),
        get(`lei-records?filter%5Bfulltext%5D=${encodeURIComponent(query)}&${page(SEARCH_SIZE)}`),
      ]);
      const seen = new Set();
      return { data: answers.flatMap((a) => a?.data || []).filter((d) => !seen.has(d.id) && seen.add(d.id)) };
    });
    const ranked = (res?.data || []).map((d) => ({ d, score: score(query, d.attributes?.entity?.legalName?.name || "", d.attributes?.entity?.status) })).sort((x, y) => y.score - x.score);
    if (!ranked.length) throw new ToolError(404, `no GLEIF entity found for "${query}". Try the full legal name or the LEI. You were not charged.`);
    rec = ranked[0].d;
    alternatives = ranked.slice(1, 6).map((x) => ({ ...brief(x.d), matchScore: x.score }));
    matchScore = ranked[0].score;
  }
  const entity = shape(rec);
  const l = entity.lei;
  const [direct, ultimate, kids, allKids] = await Promise.all([
    relation(l, "direct"), relation(l, "ultimate"),
    get(`lei-records/${l}/direct-children?${page(10)}`, { onStatus: notFound }),
    get(`lei-records/${l}/ultimate-children?${page(1)}`, { onStatus: notFound }),
  ]);
  return {
    matchedBy, ...(matchedBy === "name" ? { query, matchScore } : {}),
    ...entity,
    directParent: direct, ultimateParent: ultimate,
    children: {
      directCount: kids?.meta?.pagination?.total ?? 0, ultimateCount: allKids?.meta?.pagination?.total ?? 0,
      direct: (kids?.data || []).map(brief), directShown: Math.min(10, kids?.data?.length || 0),
    },
    alternatives,
    kycSummary: kycSummary(entity, ultimate),
    source: "GLEIF Global LEI Index (CC0), https://www.gleif.org",
  };
}
