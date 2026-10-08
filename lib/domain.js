// GET /api/domain: is a domain registered, by whom, since when and until when (RDAP, the successor of WHOIS),
// plus DNS: resolves, mail (MX) and name servers. Ported from the Apify Actor domain-whois-availability.
// RDAP server per TLD from the IANA bootstrap file. 200 = registered, 404 = available (as far as the registry says).
import { dnsQuery, parseMx } from "./dns.js";
import { badInput, cached, fetchJson, ToolError, UA, upstreamDown } from "./upstream.js";

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

export function parseBootstrap(data) {
  const map = new Map();
  for (const [tlds, urls] of data?.services ?? []) {
    const url = urls.find((u) => u.startsWith("https://")) ?? urls[0];
    if (url) for (const tld of tlds) map.set(tld.toLowerCase(), url.endsWith("/") ? url : `${url}/`);
  }
  return map;
}

/** "WWW.Example.com/path", "https://bücher.de" -> "example.com" / punycode, or null. Keeps the host's own name (no public-suffix list). */
export function normalizeDomain(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let host;
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`).hostname.toLowerCase().replace(/\.$/, ""); } catch { return null; }
  host = host.replace(/^www\./, "");
  if (!host.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[") || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const REDACTED = /redact|privacy|not disclosed|withheld|data protected|gdpr|anonymi[sz]ed|contact the registrar|statutory masking|^n\/?a$/i;
const published = (v) => { const s = str(v); return s && !REDACTED.test(s) ? s : null; };
const iso = (v) => { const s = str(v); const d = s && new Date(s); return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };
const vcard = (entity, name) => { const e = arr(arr(entity.vcardArray)[1]).find((p) => arr(p)[0] === name); return e ? { params: obj(arr(e)[1]), value: arr(e)[3] } : null; };

/** What an RDAP domain object says; never guesses what it does not say. */
export function parseRdap(data) {
  const d = obj(data);
  const events = arr(d.events).map(obj);
  const event = (action) => iso(events.find((e) => e.eventAction === action)?.eventDate);
  const entities = arr(d.entities).map(obj);
  const withRole = (role) => entities.find((e) => arr(e.roles).includes(role));
  const registrar = withRole("registrar");
  const registrant = withRole("registrant");
  const ianaId = arr(registrar?.publicIds).map(obj).find((p) => /iana registrar id/i.test(String(p.type)));
  const adr = registrant ? vcard(registrant, "adr") : null;
  const country = adr ? published(adr.params.cc) ?? (Array.isArray(adr.value) ? published(adr.value.at(-1)) : null) : null;
  const sec = obj(d.secureDNS);
  return {
    registrar: registrar ? published(vcard(registrar, "fn")?.value) : null,
    registrarIanaId: str(ianaId?.identifier),
    createdAt: event("registration"),
    updatedAt: event("last changed"),
    expiresAt: event("expiration"),
    statusCodes: arr(d.status).filter((s) => typeof s === "string"),
    nameServers: [...new Set(arr(d.nameservers).map((n) => str(obj(n).ldhName)).filter(Boolean).map((n) => n.toLowerCase().replace(/\.$/, "")))].sort(),
    dnssec: typeof sec.delegationSigned === "boolean" ? sec.delegationSigned : null,
    registrantCountry: country && country.length <= 3 ? country.toUpperCase() : country,
    registrantOrganisation: registrant ? published(vcard(registrant, "org")?.value) : null,
  };
}

const daysUntil = (isoDate, now) => (isoDate ? Math.floor((Date.parse(isoDate) - now) / 86400000) : null);

async function rdapLookup(base, domain) {
  let res;
  try { res = await fetch(`${base}domain/${encodeURIComponent(domain)}`, { headers: { accept: "application/rdap+json, application/json", "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(9000) }); }
  catch { throw upstreamDown(`The RDAP server for .${domain.split(".").at(-1)}`, "did not answer"); }
  if (res.status === 404) return { registered: false };
  if (res.status === 429 || res.status >= 500) throw upstreamDown(`The RDAP server for .${domain.split(".").at(-1)}`, `answered HTTP ${res.status}`);
  if (!res.ok) throw new ToolError(502, `The RDAP server answered HTTP ${res.status}, you were not charged.`);
  try { return { registered: true, data: parseRdap(await res.json()) }; }
  catch { throw new ToolError(502, "The RDAP server returned an unreadable answer, you were not charged."); }
}

export async function domain(q, _env, { now = Date.now() } = {}) {
  const name = normalizeDomain(q.domain ?? q.url ?? q.q);
  if (!name) throw badInput("domain is required, e.g. example.com");
  const bootstrap = await cached("iana-rdap-bootstrap", 86400, () => fetchJson(BOOTSTRAP_URL, { name: "The IANA RDAP bootstrap file", timeout: 15000 })).then(parseBootstrap);
  // The name as given; if the registry does not know it and it has 3+ labels (shop.example.com), its parent once.
  const labels = name.split(".");
  const tld = labels.at(-1);
  const base = bootstrap.get(tld);
  let rdap = null, registeredName = name;
  if (base) {
    rdap = await rdapLookup(base, name);
    if (!rdap.registered && labels.length >= 3) {
      const parent = labels.slice(1).join(".");
      const up = await rdapLookup(base, parent);
      if (up.registered) { rdap = up; registeredName = parent; }
    }
  }
  const [a, aaaa, mx, ns] = await Promise.all([dnsQuery(name, "A"), dnsQuery(name, "AAAA"), dnsQuery(name, "MX"), dnsQuery(registeredName, "NS")]);
  const mail = parseMx(mx.data);
  const dnsSaysExists = ns.data.length > 0 || a.data.length > 0 || aaaa.data.length > 0 || mx.data.length > 0;
  const registered = rdap ? rdap.registered : dnsSaysExists ? true : null;
  const r = rdap?.data ?? null;
  return {
    domain: name,
    registeredDomain: registeredName,
    registered,
    availability: registered === true ? "registered" : registered === false ? "available" : "unknown",
    rdapAvailable: !!base,
    registrar: r?.registrar ?? null,
    registrarIanaId: r?.registrarIanaId ?? null,
    createdAt: r?.createdAt ?? null,
    updatedAt: r?.updatedAt ?? null,
    expiresAt: r?.expiresAt ?? null,
    daysUntilExpiry: daysUntil(r?.expiresAt, now),
    ageDays: r?.createdAt ? Math.floor((now - Date.parse(r.createdAt)) / 86400000) : null,
    statusCodes: r?.statusCodes ?? [],
    dnssec: r?.dnssec ?? null,
    registrantCountry: r?.registrantCountry ?? null,
    registrantOrganisation: r?.registrantOrganisation ?? null,
    nameServers: r?.nameServers?.length ? r.nameServers : [...new Set(ns.data.map((n) => n.toLowerCase().replace(/\.$/, "")))].sort(),
    dns: { resolves: a.data.length > 0 || aaaa.data.length > 0, ipv4: a.data.slice(0, 5), ipv6: aaaa.data.slice(0, 5), mx: mail.hosts.slice(0, 5), nullMx: mail.nullMx },
    note: base ? "From the registry's RDAP service. 'available' means the registry has no record; premium or reserved names can still be unavailable to buy." : `No RDAP service is published for .${tld}: registration data is not available, 'registered' is inferred from DNS.`,
    source: "IANA RDAP bootstrap + the TLD registry's RDAP server; DNS over HTTPS (Cloudflare, Google)",
  };
}
