// GET /api/email-check: e-mail pre-check with no SMTP connection (ported from the Apify Actor email-list-precheck).
// Syntax, mail DNS (MX or implicit MX, null MX, NXDOMAIN), disposable domain (CC0 list), role account, free provider,
// typo suggestion. Verdict: invalid (cannot receive mail), risky (disposable, role account or likely typo) or
// unknown (nothing against it; the mailbox itself is NOT verified, that needs SMTP).
import disposableFile from "./data/disposable-domains.json" with { type: "json" };
import { lookupMail } from "./dns.js";
import { badInput, upstreamDown } from "./upstream.js";

const DISPOSABLE = new Set(disposableFile.domains);
const LOCAL_CHARS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const LABEL = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
const MAX = 50;

const fail = (problem) => ({ ok: false, problem });

/** Strips what people paste around an address: spaces, quotes, "mailto:", angle brackets, trailing punctuation. */
export function cleanInput(raw) {
  let s = String(raw).trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(/^mailto:/i, "").replace(/^<(.*)>$/, "$1").replace(/[.,;:]+$/, "").trim();
    if (/^(["'`]).*\1$/.test(s) && s.length > 1) s = s.slice(1, -1).trim();
    if (s === before) break;
  }
  return s;
}

/** Practical subset of RFC 5322/5321: dot-atoms only (no quoted local parts, comments or IP literals). */
export function parseEmail(raw) {
  const s = cleanInput(raw);
  if (!s) return fail("empty");
  const at = s.lastIndexOf("@");
  if (at < 0) return fail("missing-at-sign");
  if (s.indexOf("@") !== at) return fail("multiple-at-signs");
  const local = s.slice(0, at);
  const rawDomain = s.slice(at + 1);
  if (!local) return fail("no-local-part");
  if (!rawDomain) return fail("no-domain");
  if (/\s/.test(s)) return fail("contains-spaces");
  if (local.length > 64) return fail("local-part-too-long");
  if (!LOCAL_CHARS.test(local)) return fail(local.startsWith("\"") ? "quoted-local-part-unsupported" : "invalid-local-characters");
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return fail("misplaced-dot-in-local-part");
  if (rawDomain.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(rawDomain)) return fail("ip-address-domain-unsupported");
  let domain;
  try { domain = new URL(`http://${rawDomain}`).hostname.toLowerCase().replace(/\.$/, ""); } catch { return fail("invalid-domain"); }
  if (/[^a-z0-9.-]/.test(domain)) return fail("invalid-domain");
  if (domain.length > 253) return fail("domain-too-long");
  const labels = domain.split(".");
  if (labels.length < 2) return fail("domain-without-dot");
  if (labels.some((l) => !LABEL.test(l))) return fail("invalid-domain-label");
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1))) return fail("invalid-tld");
  return { ok: true, local, domain, normalized: `${local}@${domain}` };
}

/** The domain or any parent of it is on the disposable list (sub.mailinator.com -> mailinator.com). */
export function isDisposable(domain) {
  const labels = domain.split(".");
  for (let i = 0; i <= labels.length - 2; i++) if (DISPOSABLE.has(labels.slice(i).join("."))) return true;
  return false;
}

const ROLE_NAMES = new Set(["abuse", "accounts", "accounting", "admin", "administrator", "ads", "advertising", "billing", "bookings", "careers", "contact", "contactus", "customerservice", "customersupport", "dev", "devnull", "dns", "donotreply", "email", "enquiries", "enquiry", "feedback", "finance", "ftp", "general", "hello", "help", "helpdesk", "hostmaster", "hr", "info", "inquiries", "inquiry", "invoice", "invoices", "it", "jobs", "legal", "list", "mail", "mailer", "mailerdaemon", "marketing", "media", "news", "newsletter", "noc", "noreply", "notifications", "office", "orders", "payroll", "postmaster", "press", "privacy", "procurement", "recruiting", "recruitment", "registrar", "reply", "reservations", "root", "sales", "security", "service", "services", "shop", "spam", "staff", "subscribe", "support", "sysadmin", "team", "tech", "unsubscribe", "usenet", "uucp", "webmaster", "www"]);
export const isRoleAccount = (local) => ROLE_NAMES.has(local.toLowerCase().split("+")[0].replace(/[._-]/g, ""));

const FREE_DOMAINS = new Set(["gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.it", "yahoo.es", "yahoo.co.jp", "yahoo.com.br", "yahoo.ca", "yahoo.in", "ymail.com", "rocketmail.com", "outlook.com", "outlook.fr", "outlook.de", "hotmail.com", "hotmail.co.uk", "hotmail.fr", "hotmail.de", "hotmail.it", "hotmail.es", "live.com", "live.co.uk", "live.fr", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "protonmail.com", "proton.me", "pm.me", "gmx.com", "gmx.de", "gmx.net", "gmx.at", "gmx.ch", "mail.com", "email.com", "web.de", "t-online.de", "freenet.de", "yandex.com", "yandex.ru", "mail.ru", "inbox.ru", "bk.ru", "list.ru", "zoho.com", "zohomail.com", "qq.com", "163.com", "126.com", "sina.com", "naver.com", "daum.net", "hanmail.net", "orange.fr", "free.fr", "wanadoo.fr", "laposte.net", "sfr.fr", "libero.it", "virgilio.it", "tiscali.it", "btinternet.com", "sky.com", "talktalk.net", "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "earthlink.net", "rediffmail.com", "tutanota.com", "tuta.io", "tutamail.com", "fastmail.com", "fastmail.fm", "hey.com", "mailfence.com", "posteo.de", "mailbox.org", "seznam.cz", "wp.pl", "o2.pl", "interia.pl", "onet.pl", "ukr.net", "rambler.ru", "bol.com.br", "uol.com.br", "terra.com.br", "ig.com.br"]);
export const isFreeProvider = (domain) => FREE_DOMAINS.has(domain);

const TYPO_DOMAINS = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmal.com": "gmail.com", "gamil.com": "gmail.com", "gnail.com": "gmail.com", "gmail.co": "gmail.com", "gmail.con": "gmail.com", "gmail.cm": "gmail.com", "gmaill.com": "gmail.com", "gmil.com": "gmail.com", "gmail.om": "gmail.com", "gmailc.om": "gmail.com", "gmail.vom": "gmail.com", "gmail.comm": "gmail.com", "gmeil.com": "gmail.com", "gimail.com": "gmail.com", "gemail.com": "gmail.com", "gmail.cmo": "gmail.com", "gmaiil.com": "gmail.com", "googlemail.con": "googlemail.com",
  "hotmial.com": "hotmail.com", "hotmal.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmail.con": "hotmail.com", "hotnail.com": "hotmail.com", "hitmail.com": "hotmail.com", "homail.com": "hotmail.com", "hotmail.co": "hotmail.com", "hotmaill.com": "hotmail.com", "hotmil.com": "hotmail.com", "hotmail.cm": "hotmail.com", "hotmeil.com": "hotmail.com",
  "yahooo.com": "yahoo.com", "yaho.com": "yahoo.com", "yahoo.con": "yahoo.com", "yhaoo.com": "yahoo.com", "yahho.com": "yahoo.com", "yahoo.co": "yahoo.com", "yaoo.com": "yahoo.com", "yahoo.cm": "yahoo.com", "yahou.com": "yahoo.com", "tahoo.com": "yahoo.com", "yahoo.comm": "yahoo.com",
  "outlok.com": "outlook.com", "outloo.com": "outlook.com", "outlook.con": "outlook.com", "outlock.com": "outlook.com", "outook.com": "outlook.com", "outlookk.com": "outlook.com", "outlook.co": "outlook.com",
  "iclod.com": "icloud.com", "icloud.con": "icloud.com", "icoud.com": "icloud.com", "iclould.com": "icloud.com", "icloud.co": "icloud.com",
  "aol.con": "aol.com", "protonmail.con": "protonmail.com", "protonmal.com": "protonmail.com", "live.con": "live.com", "msn.con": "msn.com", "gmx.con": "gmx.com", "web.dee": "web.de",
};
const KNOWN = ["gmail.com", "hotmail.com", "yahoo.com", "outlook.com", "icloud.com", "protonmail.com", "aol.com", "live.com", "msn.com", "gmx.com", "googlemail.com"];
const TLD_TYPOS = new Set(["con", "cmo", "ocm", "vom", "xom", "c0m", "comm", "coom", "cim", "clm", "ner", "nte", "ogr", "orgg"]);
const TLD_FIX = { ner: "net", nte: "net", ogr: "org", orgg: "org" };

/** Optimal string alignment distance (substitution, insertion, deletion, transposition of neighbours). */
export function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

/** A better domain for a suspected typo, or null. Real providers are never "corrected". */
export function suggestDomain(domain) {
  if (FREE_DOMAINS.has(domain)) return null;
  if (TYPO_DOMAINS[domain]) return TYPO_DOMAINS[domain];
  if (domain.length >= 8) { const near = KNOWN.find((k) => distance(domain, k) === 1); if (near) return near; }
  const labels = domain.split(".");
  if (labels.length === 2 && TLD_TYPOS.has(labels[1])) return `${labels[0]}.${TLD_FIX[labels[1]] ?? "com"}`;
  return null;
}

/** One address; `mail(domain)` answers the DNS question (cached per call). */
export async function precheck(email, mail) {
  const p = parseEmail(email);
  if (!p.ok) return { email, normalized: null, verdict: "invalid", reasons: [`syntax:${p.problem}`], domain: null, mx: null, mxHosts: [], disposable: null, role: null, freeProvider: null, suggestion: null };
  const disposable = isDisposable(p.domain), role = isRoleAccount(p.local), freeProvider = isFreeProvider(p.domain);
  const fixed = suggestDomain(p.domain);
  const suggestion = fixed ? `${p.local}@${fixed}` : null;
  const m = await mail(p.domain);
  const reasons = m.nxdomain ? ["domain-not-found"] : m.nullMx ? ["null-mx"] : m.mx === false ? ["no-mx-records"] : m.mx === null ? ["dns-unavailable"] : [];
  const invalid = reasons.some((r) => r !== "dns-unavailable");
  if (disposable) reasons.push("disposable-domain");
  if (role) reasons.push("role-account");
  if (suggestion) reasons.push("typo-suspected");
  const verdict = invalid ? "invalid" : disposable || role || suggestion ? "risky" : "unknown";
  return { email, normalized: p.normalized, verdict, reasons, domain: p.domain, mx: m.mx, mxHosts: m.mxHosts, disposable, role, freeProvider, suggestion };
}

export async function emailCheck(q, _env, { lookup = lookupMail } = {}) {
  const list = (q.emails ? String(q.emails).split(/[,;\s]+/) : [q.email]).map((s) => (s ?? "").trim()).filter(Boolean);
  if (!list.length) throw badInput("email (one address) or emails (up to 50, comma-separated) is required");
  if (list.length > MAX) throw badInput(`at most ${MAX} addresses per call`);
  const cache = new Map();
  const mail = (d) => { if (!cache.has(d)) cache.set(d, lookup(d)); return cache.get(d); };
  const results = await Promise.all(list.map((e) => precheck(e, mail)));
  // If no DNS answer came back at all, nothing useful was produced: fail (not charged).
  if (results.every((r) => r.reasons.includes("dns-unavailable") || r.reasons[0]?.startsWith("syntax:")) && results.some((r) => r.reasons.includes("dns-unavailable"))) throw upstreamDown("DNS over HTTPS");
  const counts = results.reduce((a, r) => ({ ...a, [r.verdict]: (a[r.verdict] || 0) + 1 }), {});
  const note = "No SMTP connection is made: 'unknown' means nothing is wrong with the address and its domain, not that the mailbox exists.";
  return list.length === 1 && !q.emails ? { ...results[0], note } : { total: results.length, counts, results, note, disposableListSize: DISPOSABLE.size };
}
