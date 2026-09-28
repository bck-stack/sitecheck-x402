// Paid tools. Each takes plain inputs and returns JSON. No external keys needed.
const UA = "Mozilla/5.0 (compatible; SiteCheckAPI/1.0)";

export function normUrl(raw) {
  if (!raw || typeof raw !== "string") throw new Error("url is required");
  const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) urls");
  const h = u.hostname;
  if (h === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith(".local") || h.includes(":"))
    throw new Error("private addresses are not allowed");
  return u;
}

async function get(url, ms = 12000) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
  const text = (await r.text()).slice(0, 600_000);
  return { status: r.status, url: r.url, headers: r.headers, text };
}

const strip = (s) => s.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
const attr = (tag, name) => (tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")) || [])[2] ?? (tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")) || [])[3] ?? (tag.match(new RegExp(`\\s${name}\\s*=\\s*([^\\s>"']+)`, "i")) || [])[1];
const has = (tag, name) => new RegExp(`\\s${name}(\\s|=|>|/)`, "i").test(tag);
const tags = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) || [];
const decode = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const text = (s) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// ---------- /api/audit ----------
export async function audit(rawUrl) {
  const u = normUrl(rawUrl);
  const t0 = Date.now();
  const page = await get(u.href);
  const html = strip(page.text);
  const issues = [];
  const add = (severity, rule, wcag, count, detail, fix) => count && issues.push({ severity, rule, wcag, count, detail, fix });

  const htmlTag = tags(html, "html")[0] || "";
  add("serious", "html-lang", "3.1.1", attr(htmlTag, "lang") ? 0 : 1, "<html> has no lang attribute", 'Add lang, e.g. <html lang="en">');
  const title = text((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  add("serious", "document-title", "2.4.2", title ? 0 : 1, "Page has no <title>", "Add a descriptive <title>");

  const imgs = tags(html, "img");
  const noAlt = imgs.filter((t) => !has(t, "alt"));
  add("critical", "image-alt", "1.1.1", noAlt.length, `${noAlt.length} of ${imgs.length} images have no alt attribute`, 'Add alt text; use alt="" for decorative images');

  const inputs = tags(html, "input").filter((t) => !/type\s*=\s*["']?(hidden|submit|button|image|reset)/i.test(t));
  const labelFor = new Set(tags(html, "label").map((t) => attr(t, "for")).filter(Boolean));
  const unlabeled = [...inputs, ...tags(html, "select"), ...tags(html, "textarea")].filter((t) => {
    const id = attr(t, "id");
    return !(id && labelFor.has(id)) && !has(t, "aria-label") && !has(t, "aria-labelledby") && !has(t, "title");
  });
  add("critical", "label", "1.3.1 / 4.1.2", unlabeled.length, `${unlabeled.length} form fields may have no accessible label (wrapping <label> not detected)`, "Connect each field to a <label for> or aria-label");

  const btns = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gi) || [];
  const emptyBtn = btns.filter((b) => !text(b) && !/aria-label|aria-labelledby|title=/i.test(b) && !/<img[^>]+alt\s*=\s*["'][^"']+/i.test(b));
  add("critical", "button-name", "4.1.2", emptyBtn.length, `${emptyBtn.length} buttons have no text or aria-label`, "Give icon buttons an aria-label");

  const links = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  const emptyLinks = links.filter((a) => !text(a) && !/aria-label|aria-labelledby|title=/i.test(a) && !/<img[^>]+alt\s*=\s*["'][^"']+/i.test(a));
  add("serious", "link-name", "2.4.4", emptyLinks.length, `${emptyLinks.length} links have no text`, "Add link text or aria-label");
  const vague = links.filter((a) => /^(click here|here|read more|more|learn more)$/i.test(text(a)));
  add("minor", "link-purpose", "2.4.4", vague.length, `${vague.length} links use vague text like "click here"`, "Describe where the link goes");

  const h1 = tags(html, "h1").length;
  add("moderate", "page-has-heading-one", "1.3.1", h1 === 0 ? 1 : 0, "No <h1> on the page", "Add one main <h1>");
  const levels = (html.match(/<h([1-6])\b/gi) || []).map((h) => +h[2]);
  let skips = 0; for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) skips++;
  add("moderate", "heading-order", "1.3.1", skips, `${skips} skipped heading levels (e.g. h2 → h4)`, "Keep heading levels sequential");

  const vp = tags(html, "meta").find((t) => /name\s*=\s*["']?viewport/i.test(t)) || "";
  add("serious", "meta-viewport", "1.4.4", /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(vp) ? 1 : 0, "Viewport blocks zoom", "Remove user-scalable=no / maximum-scale=1");
  add("serious", "skip-link / landmarks", "2.4.1", /<main\b|role\s*=\s*["']main/i.test(html) || /href\s*=\s*["']#(main|content)/i.test(html) ? 0 : 1, "No <main> landmark or skip link", "Wrap main content in <main> and add a skip link");
  const tabpos = (html.match(/tabindex\s*=\s*["']?[1-9]/gi) || []).length;
  add("moderate", "tabindex", "2.4.3", tabpos, `${tabpos} elements use positive tabindex`, "Use tabindex 0 or -1 only");
  const frames = tags(html, "iframe").filter((t) => !has(t, "title"));
  add("serious", "frame-title", "4.1.2", frames.length, `${frames.length} iframes have no title`, "Add a title to each iframe");
  const autoplay = tags(html, "video").filter((t) => has(t, "autoplay") && !has(t, "muted"));
  add("moderate", "no-autoplay-audio", "1.4.2", autoplay.length, `${autoplay.length} videos autoplay with sound`, "Mute autoplay or add controls");

  // SEO + security basics
  const metas = tags(page.text, "meta");
  const desc = metas.find((t) => /name\s*=\s*["']?description/i.test(t));
  const h = (n) => page.headers.get(n);
  const seo = {
    title, titleLength: title.length,
    metaDescription: desc ? decode(attr(desc, "content") || "") : null,
    canonical: (tags(page.text, "link").find((t) => /rel\s*=\s*["']?canonical/i.test(t)) && attr(tags(page.text, "link").find((t) => /rel\s*=\s*["']?canonical/i.test(t)), "href")) || null,
    ogImage: !!metas.find((t) => /property\s*=\s*["']?og:image/i.test(t)),
    h1Count: h1, images: imgs.length, links: links.length,
  };
  const security = {
    https: page.url.startsWith("https://"),
    hsts: !!h("strict-transport-security"),
    csp: !!h("content-security-policy"),
    xFrameOptions: !!h("x-frame-options"),
    xContentTypeOptions: !!h("x-content-type-options"),
    referrerPolicy: !!h("referrer-policy"),
  };
  const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  const penalty = issues.reduce((s, i) => s + ({ critical: 15, serious: 10, moderate: 5, minor: 2 })[i.severity], 0);
  return {
    url: page.url, httpStatus: page.status, fetchedMs: Date.now() - t0,
    accessibility: { standard: "WCAG 2.2 AA (static HTML checks)", score: Math.max(0, 100 - penalty), issues },
    seo, security, tech: detectTech(page.text, page.headers),
    note: "Static analysis of server-rendered HTML. Contrast, keyboard and JS-rendered content need a browser check.",
  };
}

export function detectTech(html, headers) {
  const t = [];
  const s = (re, name) => re.test(html) && t.push(name);
  s(/cdn\.shopify\.com|Shopify\.theme/i, "Shopify"); s(/wp-content|wp-includes/i, "WordPress"); s(/plugins\/woocommerce|wc-block|woocommerce-page/i, "WooCommerce");
  s(/static\.wixstatic|wix\.com/i, "Wix"); s(/squarespace/i, "Squarespace"); s(/webflow/i, "Webflow"); s(/__NEXT_DATA__|\/_next\//, "Next.js");
  s(/__nuxt|\/_nuxt\//, "Nuxt"); s(/data-reactroot|react-dom/i, "React"); s(/gatsby/i, "Gatsby"); s(/framer\.com|framerusercontent/i, "Framer");
  s(/googletagmanager\.com/i, "Google Tag Manager"); s(/google-analytics\.com|gtag\(/i, "Google Analytics"); s(/plausible\.io/i, "Plausible");
  s(/js\.stripe\.com/i, "Stripe"); s(/intercom/i, "Intercom"); s(/hubspot/i, "HubSpot"); s(/klaviyo/i, "Klaviyo"); s(/crisp\.chat/i, "Crisp");
  s(/cloudflare/i, "Cloudflare"); s(/hotjar/i, "Hotjar"); s(/tailwind/i, "Tailwind");
  const server = headers?.get?.("server"); if (server) t.push(`server: ${server}`);
  const pb = headers?.get?.("x-powered-by"); if (pb) t.push(`x-powered-by: ${pb}`);
  return [...new Set(t)];
}

// ---------- /api/contacts ----------
const SOCIAL = { linkedin: /linkedin\.com\/(company|in)\/[^"'\s<>?#]+/i, x: /(?:twitter|x)\.com\/(?!intent|share|home)[A-Za-z0-9_]{2,15}(?=["'\/?#\s<])/i, facebook: /facebook\.com\/(?!sharer|share|tr\b|plugins)[^"'\s<>?#]+/i, instagram: /instagram\.com\/[^"'\s<>?#]+/i, youtube: /youtube\.com\/(@|channel\/|c\/)[^"'\s<>?#]+/i, github: /github\.com\/[A-Za-z0-9-]+(?=["'\/\s<])/i, tiktok: /tiktok\.com\/@[^"'\s<>?#]+/i };
const BAD_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js)$|example\.|@sentry|wixpress|@2x|domain\.com|email\.com|yourcompany/i;

export async function contacts(rawUrl) {
  const u = normUrl(rawUrl);
  const paths = ["", "/contact", "/contact-us", "/about", "/impressum", "/legal"];
  const pages = await Promise.all(paths.map((p) => get(new URL(p || "/", u.origin).href, 9000).catch(() => null)));
  const emails = new Set(), phones = new Set(), socials = {};
  const checked = [];
  for (const [i, p] of pages.entries()) {
    if (!p || p.status >= 400) continue;
    checked.push(p.url);
    const html = p.text.replace(/&#64;|&commat;|\[at\]|\(at\)/gi, "@");
    for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) emails.add(decodeURIComponent(m[1]).toLowerCase());
    for (const m of text(strip(html)).matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) emails.add(m[0].toLowerCase());
    for (const m of html.matchAll(/tel:([+\d][\d\s().-]{6,})/gi)) phones.add(m[1].trim());
    for (const [k, re] of Object.entries(SOCIAL)) if (!socials[k]) { const m = html.match(re); if (m) socials[k] = "https://" + m[0].replace(/^https?:\/\//, "").replace(/^www\./, ""); }
    if (i === 0) var home = p;
  }
  const domain = u.hostname.replace(/^www\./, "");
  const list = [...emails].filter((e) => !BAD_EMAIL.test(e));
  list.sort((a, b) => (b.endsWith(domain) - a.endsWith(domain)));
  const htmlHome = home?.text || "";
  return {
    domain,
    name: text((htmlHome.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)/i) || htmlHome.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "") || null,
    description: (htmlHome.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)/i) || [])[1] || null,
    emails: list.map((e) => ({ email: e, sameDomain: e.endsWith("@" + domain) || e.endsWith("." + domain) })),
    phones: [...phones].slice(0, 5),
    socials, tech: home ? detectTech(home.text, home.headers) : [], pagesChecked: checked,
  };
}

// ---------- /api/hiring ----------
// Latest Hacker News "Who is hiring?" thread, filtered by keyword.
export async function hiring({ q = "", remote = "", limit = 30 } = {}) {
  const j = await (await fetch("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5", { signal: AbortSignal.timeout(10000) })).json();
  const thread = j.hits.find((h) => /who is hiring/i.test(h.title));
  if (!thread) throw new Error("no hiring thread found");
  const words = String(q).toLowerCase().split(/[\s,]+/).filter(Boolean);
  const out = [];
  let page = 0, pages = 1;
  while (page < pages && page < 6) {
    const c = await (await fetch(`https://hn.algolia.com/api/v1/search?tags=comment,story_${thread.objectID}&hitsPerPage=200&page=${page}`, { signal: AbortSignal.timeout(10000) })).json();
    pages = c.nbPages;
    for (const h of c.hits) {
      if (h.parent_id != thread.objectID || !h.comment_text) continue;
      const body = text(h.comment_text.replace(/<p>/g, "\n"));
      const low = body.toLowerCase();
      if (words.length && !words.every((w) => low.includes(w))) continue;
      if (remote && !/remote/i.test(body)) continue;
      out.push({ company: body.split("|")[0].trim().slice(0, 80), headline: body.split(/\n| {2}/)[0].slice(0, 240), text: body.slice(0, 1500), emails: [...new Set(body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])], url: `https://news.ycombinator.com/item?id=${h.objectID}`, postedAt: h.created_at });
    }
    page++;
  }
  out.sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  return { thread: { title: thread.title, url: `https://news.ycombinator.com/item?id=${thread.objectID}` }, query: q || null, remoteOnly: !!remote, total: out.length, results: out.slice(0, Math.min(+limit || 30, 100)) };
}
