// GET /api/sitemap: every URL a site lists in its XML sitemaps (robots.txt Sitemap: lines, then /sitemap.xml and
// /sitemap_index.xml), with lastmod, following sitemap indexes up to 25 child sitemaps. Optional path prefix and
// "changed since" filters. For agents that need a site's page list before reading pages.
import { normUrl } from "./tools.js";
import { badInput, clampInt, isoDate, ToolError } from "./upstream.js";

const UA = "Mozilla/5.0 (compatible; SiteCheckReader/1.0; +https://api.sitecheck-api.workers.dev)";
const MAX_CHILDREN = 25;

const decodeXml = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").trim();
const tag = (block, name) => { const m = new RegExp(`<(?:[a-z]+:)?${name}>([\\s\\S]*?)</(?:[a-z]+:)?${name}>`, "i").exec(block); return m ? decodeXml(m[1]) : null; };

/** { kind: "index"|"urlset"|null, entries: [{loc, lastmod}] } */
export function parseSitemap(xml) {
  const kind = /<(?:[a-z]+:)?sitemapindex\b/i.test(xml) ? "index" : /<(?:[a-z]+:)?urlset\b/i.test(xml) ? "urlset" : null;
  const blockTag = kind === "index" ? "sitemap" : "url";
  const entries = [];
  for (const m of xml.matchAll(new RegExp(`<(?:[a-z]+:)?${blockTag}\\b[^>]*>([\\s\\S]*?)</(?:[a-z]+:)?${blockTag}>`, "gi"))) {
    const loc = tag(m[1], "loc");
    if (loc) entries.push({ loc, lastmod: tag(m[1], "lastmod") });
  }
  return { kind, entries };
}

async function getText(url, ms = 10000) {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/xml,text/xml,text/plain,*/*" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return null; }
    if (/gzip|x-gzip/.test(r.headers.get("content-type") || "") || url.endsWith(".gz")) {
      const ds = r.body.pipeThrough(new DecompressionStream("gzip"));
      return (await new Response(ds).text()).slice(0, 20_000_000);
    }
    return (await r.text()).slice(0, 20_000_000);
  } catch { return null; }
}

export async function sitemap(q) {
  let u;
  try { u = normUrl(q.url); } catch (e) { throw badInput(e.message); }
  const limit = clampInt(q.limit, 1000, 1, 10000);
  const prefix = q.pathPrefix ? String(q.pathPrefix) : null;
  const since = isoDate(q.since, "since");
  const robots = await getText(`${u.origin}/robots.txt`, 5000);
  const declared = robots ? [...robots.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]) : [];
  const candidates = [...new Set([...declared, `${u.origin}/sitemap.xml`, `${u.origin}/sitemap_index.xml`])];
  const urls = new Map();
  const read = [];
  const queue = [];
  for (const c of candidates) {
    const xml = await getText(c);
    if (!xml) continue;
    const p = parseSitemap(xml);
    if (!p.kind) continue;
    read.push(c);
    if (p.kind === "index") queue.push(...p.entries.map((e) => e.loc));
    else for (const e of p.entries) urls.set(e.loc, e.lastmod);
    if (declared.length && read.length) break; // the declared sitemap is enough
  }
  let children = 0;
  while (queue.length && children < MAX_CHILDREN && urls.size < limit * 2) {
    const next = queue.shift();
    children++;
    const xml = await getText(next);
    if (!xml) continue;
    const p = parseSitemap(xml);
    read.push(next);
    if (p.kind === "index") queue.push(...p.entries.map((e) => e.loc));
    else for (const e of p.entries) urls.set(e.loc, e.lastmod);
  }
  if (!read.length) throw new ToolError(404, `No XML sitemap found for ${u.host} (robots.txt, /sitemap.xml, /sitemap_index.xml); you were not charged.`);
  let rows = [...urls].map(([loc, lastmod]) => ({ url: loc, lastmod }));
  if (prefix) rows = rows.filter((r) => { try { return new URL(r.url).pathname.startsWith(prefix); } catch { return false; } });
  if (since) rows = rows.filter((r) => r.lastmod && r.lastmod.slice(0, 10) >= since);
  rows.sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));
  return {
    site: u.origin, sitemapsRead: read.length, sitemaps: read.slice(0, 50), childSitemapsSkipped: queue.length,
    totalUrls: rows.length, returned: Math.min(rows.length, limit), truncated: rows.length > limit,
    urls: rows.slice(0, limit),
    note: `Newest lastmod first. Indexes are followed up to ${MAX_CHILDREN} child sitemaps per call.`,
  };
}
