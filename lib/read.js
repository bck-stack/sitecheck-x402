// GET /api/read: one web page as clean Markdown (or plain text) for LLMs and agents, with title, description,
// author, published date, language, canonical URL and, on request, the page's links. The main content is taken from
// <article> or <main> when the page has one, otherwise from <body> without navigation, header, footer and asides.
// robots.txt is respected (a disallowed page is refused and not charged). No JavaScript is run.
import { normUrl } from "./tools.js";
import { badInput, clampInt, ToolError, upstreamDown } from "./upstream.js";

const UA = "Mozilla/5.0 (compatible; SiteCheckReader/1.0; +https://api.sitecheck-api.workers.dev)";
const ROBOTS_AGENT = "sitecheckreader";
const MAX_BYTES = 3_000_000;

const ENTITIES = { quot: "\"", apos: "'", lt: "<", gt: ">", nbsp: " ", amp: "&", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", euro: "€", pound: "£", times: "×" };
export const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => safeChar(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
const safeChar = (n) => (n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "");
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? "") : null;
};
const meta = (html, key) => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const k = (attr(tag, "name") || attr(tag, "property") || attr(tag, "itemprop") || "").toLowerCase();
    if (k === key) return attr(tag, "content")?.trim() || null;
  }
  return null;
};
const stripTags = (s) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const absolute = (href, base) => {
  try { const u = new URL(href, base); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
};

/** Page metadata from the <head> and common meta tags. */
export function pageMeta(html, base) {
  const title = meta(html, "og:title") || stripTags((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "") || null;
  const canonicalTag = (html.match(/<link\b[^>]*>/gi) || []).find((t) => /\srel\s*=\s*["']?canonical/i.test(t));
  return {
    title,
    description: meta(html, "description") || meta(html, "og:description"),
    author: meta(html, "author") || meta(html, "article:author"),
    publishedAt: meta(html, "article:published_time") || meta(html, "datepublished") || meta(html, "date"),
    lang: attr((/<html\b[^>]*>/i.exec(html) || [""])[0], "lang"),
    canonical: canonicalTag ? absolute(attr(canonicalTag, "href") || "", base) : null,
    siteName: meta(html, "og:site_name"),
  };
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const TAG = /<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/gi;

/** Removes whole elements (with their children, tags balanced) whose opening tag passes `test(tag, openingTag)`. */
export function dropElements(html, test) {
  let out = "", last = 0, skip = null, depth = 0, m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(html))) {
    const [full, close, raw, attrs] = m;
    const tag = raw.toLowerCase();
    if (VOID.has(tag) || attrs.endsWith("/")) continue;
    if (skip) {
      if (tag === skip && (depth += close ? -1 : 1) === 0) { skip = null; last = TAG.lastIndex; }
      continue;
    }
    if (!close && test(tag, full)) { out += html.slice(last, m.index); skip = tag; depth = 1; }
  }
  return skip ? out : out + html.slice(last);
}

/** Inner HTML of the first element whose opening tag passes `test`, tags balanced; null if none. */
export function innerOf(html, test) {
  let m, start = -1, skip = null, depth = 0;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(html))) {
    const [full, close, raw, attrs] = m;
    const tag = raw.toLowerCase();
    if (VOID.has(tag) || attrs.endsWith("/")) continue;
    if (skip) {
      if (tag === skip && (depth += close ? -1 : 1) === 0) return html.slice(start, m.index);
    } else if (!close && test(tag, full)) { skip = tag; depth = 1; start = TAG.lastIndex; }
  }
  return start >= 0 ? html.slice(start) : null;
}

const tokens = (tag) => `${attr(tag, "class") || ""} ${attr(tag, "id") || ""}`.toLowerCase().split(/\s+/).filter(Boolean);
// Containers that usually hold the article body, tried before <article> and <main>.
const BODY_IDS = new Set(["mw-content-text", "article-body", "articlebody", "main-content", "maincontent", "content-body", "post-content", "entry-content"]);
const BODY_CLASSES = new Set(["entry-content", "post-content", "article-body", "article-content", "articlebody", "post-body", "story-body", "markdown-body", "rich-text", "prose"]);
// Boilerplate inside the chosen container: menus, cookie banners, share bars, language lists, tables of contents.
const NOISE = /^(nav|navbar|navigation|menu|menubar|sidebar|breadcrumbs?|cookie[s-]?.*|consent.*|share|sharing|social|related(-.*)?|advert.*|ads|ad-.*|promo.*|newsletter.*|subscribe.*|popup|modal|toc|skip.*|navbox|catlinks|printfooter|mw-jump-link|mw-editsection|reflist|references|noprint|sr-only|visually-hidden|screen-reader-text|vector-.*|mw-portlet.*)$/;
const ROLES = /^(navigation|banner|contentinfo|complementary|search|dialog|alertdialog|menu|menubar)$/;

/** HTML to Markdown, main content only. Returns { markdown, links }. Images only when `images` is true. */
export function htmlToMarkdown(html, base, { images = false } = {}) {
  let h = html.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|select|button|object|video|audio|map)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<head\b[\s\S]*?<\/head\s*>/i, "");
  const long = (s) => (s && stripTags(s).length > 200 ? s : null);
  const main = long(innerOf(h, (tag, open) => BODY_IDS.has((attr(open, "id") || "").toLowerCase()) || tokens(open).some((t) => BODY_CLASSES.has(t)) || /articlebody/i.test(attr(open, "itemprop") || "")))
    ?? long(innerOf(h, (tag) => tag === "article"))
    ?? long(innerOf(h, (tag, open) => tag === "main" || attr(open, "role") === "main"));
  h = main ?? innerOf(h, (tag) => tag === "body") ?? h;
  h = dropElements(h, (tag, open) =>
    (!main && /^(nav|header|footer|aside|form|dialog)$/.test(tag)) || (main && /^(nav|aside|form|dialog)$/.test(tag))
    || ROLES.test(attr(open, "role") || "") || /^true$/i.test(attr(open, "aria-hidden") || "") || /\shidden(?=[\s>/])/i.test(open)
    || tokens(open).some((t) => NOISE.test(t)));
  if (!images) h = h.replace(/<img\b[^>]*>/gi, " ");

  // Code blocks keep their whitespace: set aside before whitespace is collapsed.
  const blocks = [];
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, code) => {
    blocks.push(decode(code.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/\n+$/, ""));
    return ` \u0000${blocks.length - 1}\u0000 `;
  });
  h = h.replace(/\s+/g, " ");

  const links = [];
  const seen = new Set();
  h = h
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, n, t) => { const s = stripTags(t); return s ? `\n\n${"#".repeat(+n)} ${s}\n\n` : ""; })
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_, a, t) => {
      const text = stripTags(t);
      const url = absolute(attr(` ${a}`, "href") || "", base);
      if (!url || !text) return text ? ` ${text} ` : " ";
      if (!seen.has(url)) { seen.add(url); links.push({ text: text.slice(0, 200), url }); }
      return ` [${text.replace(/[[\]]/g, "")}](${url}) `;
    })
    .replace(/<img\b[^>]*>/gi, (tag) => { const alt = (attr(tag, "alt") || "").trim(); const src = absolute(attr(tag, "src") || "", base); return alt && src ? ` ![${alt.replace(/[[\]]/g, "")}](${src}) ` : " "; })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, __, t) => { const s = t.trim(); return s ? ` **${s}** ` : " "; })
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, __, t) => { const s = t.trim(); return s ? ` *${s}* ` : " "; })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, t) => ` \`${stripTags(t)}\` `)
    .replace(/<blockquote\b[^>]*>/gi, "\n\n> ").replace(/<\/blockquote\s*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/li\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\b[^>]*>/gi, "\n\n---\n\n")
    .replace(/<\/(td|th)\s*>/gi, " | ").replace(/<tr\b[^>]*>/gi, "\n| ")
    .replace(/<\/?(p|div|section|article|main|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|figure|figcaption|header|footer|details|summary|address)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  let md = decode(h)
    .split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^- ?$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  md = md.replace(/\u0000(\d+)\u0000/g, (_, i) => `\n\n\`\`\`\n${blocks[+i]}\n\`\`\`\n\n`).replace(/\n{3,}/g, "\n\n").trim();
  return { markdown: md, links };
}

/** robots.txt rules for our agent (or "*"): longest matching Allow/Disallow wins. Returns true when allowed. */
export function robotsAllows(txt, path, agent = ROBOTS_AGENT) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) groups.push(cur = { agents: [], rules: [] });
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === "allow" || key === "disallow")) cur.rules.push({ allow: key === "allow", path: val });
    }
  }
  const pick = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const rules = (pick.length ? pick : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules).filter((r) => r.path);
  let best = null;
  for (const r of rules) {
    const re = new RegExp(`^${r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
    if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

async function readBody(res) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(value);
    if (total > MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
  }
  const all = new Uint8Array(Math.min(total, MAX_BYTES + 65536));
  let off = 0;
  for (const c of chunks) { if (off + c.byteLength > all.length) break; all.set(c, off); off += c.byteLength; }
  const type = res.headers.get("content-type") || "";
  const charset = /charset=([\w-]+)/i.exec(type)?.[1];
  try { return new TextDecoder(charset || "utf-8").decode(all.subarray(0, off)); } catch { return new TextDecoder("utf-8").decode(all.subarray(0, off)); }
}

export async function read(q) {
  let u;
  try { u = normUrl(q.url); } catch (e) { throw badInput(e.message); }
  const format = q.format === "text" ? "text" : "markdown";
  const maxChars = clampInt(q.maxChars, 30000, 500, 200000);
  const wantLinks = q.links === "1" || q.links === "true";
  const images = q.images === "1" || q.images === "true";

  try {
    const r = await fetch(`${u.origin}/robots.txt`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(4000) });
    if (r.ok && /text\/plain/i.test(r.headers.get("content-type") || "text/plain")) {
      const txt = (await r.text()).slice(0, 500_000);
      if (!robotsAllows(txt, `${u.pathname}${u.search}`)) throw new ToolError(403, `robots.txt of ${u.host} does not allow reading ${u.pathname}; you were not charged.`);
    }
  } catch (e) { if (e instanceof ToolError) throw e; /* no robots.txt or unreachable: allowed */ }

  let res;
  try { res = await fetch(u.href, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "accept-language": "en;q=0.9,*;q=0.5" }, redirect: "follow", signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw (e?.name === "TimeoutError" ? upstreamDown(u.host, "timed out") : new ToolError(502, `${u.host} could not be reached, you were not charged.`)); }
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new ToolError(502, `${u.host} answered HTTP ${res.status}, you were not charged.`); }
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (/pdf|image\/|audio\/|video\/|octet-stream|zip|font\//.test(type)) { await res.body?.cancel().catch(() => {}); throw new ToolError(415, `The page is ${type.split(";")[0]}, not HTML or text; you were not charged.`); }
  const body = await readBody(res);
  const finalUrl = res.url || u.href;

  let out, metaInfo = {}, links = [];
  if (/html|xml/.test(type) || /^\s*<(!doctype html|html|head|body)/i.test(body)) {
    metaInfo = pageMeta(body, finalUrl);
    const conv = htmlToMarkdown(body, finalUrl, { images });
    links = conv.links;
    out = format === "text"
      ? conv.markdown.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^#+ /gm, "").replace(/\*\*|`{3}|`/g, "")
      : conv.markdown;
    if (metaInfo.title && format === "markdown" && !/^# /m.test(out)) out = `# ${metaInfo.title}\n\n${out}`;
  } else out = body.trim();

  if (!out.replace(/[#\s]/g, "")) throw new ToolError(422, "The page has no readable text without JavaScript; you were not charged.");
  const truncated = out.length > maxChars;
  const content = truncated ? `${out.slice(0, maxChars)}\n\n[truncated]` : out;
  return {
    url: u.href, finalUrl, status: res.status, contentType: type.split(";")[0] || null,
    ...metaInfo,
    format, content, chars: content.length, wordCount: content.split(/\s+/).filter(Boolean).length, truncated,
    ...(wantLinks ? { links: links.slice(0, 300), linkCount: links.length } : {}),
    fetchedAt: new Date().toISOString(),
    note: "Fetched once, no JavaScript run; robots.txt respected. Content belongs to its publisher.",
  };
}
