// GET /api/tech: the technologies a website uses (CMS, e-commerce, analytics, tag managers, CDN, hosting, chat,
// payments, e-mail provider...) with version, confidence and evidence. Ported from the Apify Actor
// website-tech-stack-detector: 231 own fingerprints (MIT, not derived from Wappalyzer) over the home page's markup,
// script URLs, meta tags, headers and cookies, plus the domain's MX and TXT records over DNS.
import fingerprintFile from "./data/tech-fingerprints.json" with { type: "json" };
import { dnsQuery } from "./dns.js";
import { normUrl } from "./tools.js";
import { badInput, ToolError, upstreamDown } from "./upstream.js";

const FINGERPRINTS = fingerprintFile.technologies;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const WEIGHT = { meta: 95, header: 85, cookie: 70, script: 80, html: 55, mx: 95, txt: 80 };
const compiled = new Map();
const re = (p) => { let r = compiled.get(p); if (!r) { r = new RegExp(p, "i"); compiled.set(p, r); } return r; };
const short = (s, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Script, stylesheet and iframe URLs plus URLs inside inline code (links <a> excluded), and meta name -> content. */
export function pageSignals(html, headers, cookies) {
  const urls = new Set();
  for (const m of html.matchAll(/<(?:script|link|iframe)\b[^>]*?\s(?:src|href)\s*=\s*["']?([^"'\s>]+)/gi)) urls.add(m[1].trim());
  const noLinks = html.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "");
  for (const m of noLinks.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}\/[^\s"'<>)\\]*/gi)) if (urls.size < 600) urls.add(m[0]);
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const name = /\sname\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\scontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (name && content && !(name in meta)) meta[name] = content[1] ?? content[2] ?? "";
  }
  return { html, urls: [...urls], meta, headers, cookies };
}

function matchOne(fp, s) {
  const hits = [];
  const add = (kind, evidence, m) => hits.push({ kind, evidence: short(evidence), version: m?.[1] ?? null });
  for (const [name, p] of Object.entries(fp.meta ?? {})) { const v = s.meta[name]; const m = v !== undefined ? re(p).exec(v) : null; if (m) add("meta", `meta ${name}: ${v}`, m); }
  for (const [name, p] of Object.entries(fp.headers ?? {})) { const v = s.headers.get(name); const m = v != null ? re(p).exec(v) : null; if (m) add("header", `header ${name}: ${v}`, m); }
  for (const p of fp.cookies ?? []) { const c = s.cookies.find((x) => re(p).test(x)); if (c) add("cookie", `cookie ${c}`, null); }
  for (const p of fp.scripts ?? []) { const u = s.urls.find((x) => re(p).test(x)); if (u) add("script", `url ${u}`, null); }
  for (const p of fp.html ?? []) { const m = re(p).exec(s.html); if (m) add("html", `html ${m[0]}`, m); }
  for (const p of fp.mx ?? []) { const h = s.mx.find((x) => re(p).test(x)); if (h) add("mx", `MX ${h}`, null); }
  for (const p of fp.txt ?? []) { const t = s.txt.find((x) => re(p).test(x)); if (t) add("txt", `TXT ${t}`, null); }
  return hits;
}

/** Every fingerprint over the signals, strongest evidence first; unknown generators and servers are added too. */
export function detectTechnologies(s) {
  const found = [];
  const known = new Set();
  for (const fp of FINGERPRINTS) {
    const hits = matchOne(fp, s);
    if (!hits.length) continue;
    let version = hits.map((h) => h.version).find(Boolean) ?? null;
    if (!version && fp.version) {
      for (const h of [...s.urls, ...hits.map((x) => x.evidence)]) { const m = re(fp.version).exec(h); if (m?.[1]) { version = m[1]; break; } }
      version ??= re(fp.version).exec(s.html)?.[1] ?? null;
    }
    const kinds = new Map();
    for (const h of hits) if (!kinds.has(h.kind)) kinds.set(h.kind, h);
    const confidence = Math.round(100 * (1 - [...kinds.keys()].reduce((p, k) => p * (1 - WEIGHT[k] / 100), 1)));
    known.add(fp.name.toLowerCase());
    found.push({ name: fp.name, category: fp.category, version, confidence, evidence: [...kinds.values()].map((h) => h.evidence).slice(0, 5) });
  }
  const gen = s.meta.generator;
  if (gen && !known.has(gen.split(/[\s/]/)[0].toLowerCase())) found.push({ name: short(gen.split(/\s+\d/)[0], 60), category: "CMS", version: /(\d+(?:\.\d+)+)/.exec(gen)?.[1] ?? null, confidence: 60, evidence: [`meta generator: ${short(gen)}`] });
  const server = s.headers.get("server");
  if (server && !known.has(server.split("/")[0].toLowerCase())) found.push({ name: short(server.split("/")[0], 60), category: "Web server", version: server.split("/")[1]?.split(" ")[0] ?? null, confidence: 60, evidence: [`header server: ${short(server)}`] });
  const powered = s.headers.get("x-powered-by");
  if (powered && !known.has(powered.split("/")[0].toLowerCase())) found.push({ name: short(powered.split("/")[0], 60), category: "Programming language", version: powered.split("/")[1] ?? null, confidence: 60, evidence: [`header x-powered-by: ${short(powered)}`] });
  return found.sort((a, b) => b.confidence - a.confidence || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

const firstOf = (l, ...c) => l.find((t) => c.includes(t.category))?.name ?? null;
const allOf = (l, ...c) => l.filter((t) => c.includes(t.category)).map((t) => t.name);
export const summarize = (l) => ({ cms: firstOf(l, "CMS", "Website builder"), ecommerce: firstOf(l, "Ecommerce"), analytics: allOf(l, "Analytics"), tagManagers: allOf(l, "Tag manager"), cdn: allOf(l, "CDN"), hosting: allOf(l, "Hosting", "Web server"), emailProvider: firstOf(l, "Email") });

const cookieNames = (headers) => {
  const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : (headers.get("set-cookie") || "").split(/,(?=\s*[^;=\s]+=)/);
  return raw.map((c) => c.split("=")[0].trim()).filter(Boolean);
};

export async function tech(q) {
  let u;
  try { u = normUrl(q.url); } catch (e) { throw badInput(e.message); }
  let res;
  try { res = await fetch(u.href, { headers: { "user-agent": UA, accept: "text/html,*/*;q=0.8", "accept-language": "en" }, redirect: "follow", signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw (e?.name === "TimeoutError" ? upstreamDown(u.host, "timed out") : new ToolError(502, `${u.host} could not be reached, you were not charged.`)); }
  if (res.status >= 500 || res.status === 404) { await res.body?.cancel().catch(() => {}); throw new ToolError(502, `${u.host} answered HTTP ${res.status}, you were not charged.`); }
  const html = (await res.text()).slice(0, 1_500_000);
  const final = new URL(res.url || u.href);
  const domain = final.hostname.replace(/^www\./, "");
  const [mx, txt] = await Promise.all([dnsQuery(domain, "MX"), dnsQuery(domain, "TXT")]);
  const signals = { ...pageSignals(html, res.headers, cookieNames(res.headers)), mx: mx.data.map((r) => r.replace(/^\s*\d+\s+/, "").toLowerCase().replace(/\.$/, "")), txt: txt.data.map((r) => [...r.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("") || r) };
  const technologies = detectTechnologies(signals);
  return {
    url: u.href, finalUrl: final.href, status: res.status, domain,
    ...summarize(technologies),
    technologies, count: technologies.length,
    blocked: res.status === 403 || res.status === 429 ? "the site answered with a bot challenge; only headers and DNS were read" : null,
    note: "Home page markup, headers, cookies and DNS (MX, TXT) only; no JavaScript is run. Confidence 0-100 reflects the kind of evidence.",
  };
}
