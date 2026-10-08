import { test } from "node:test";
import assert from "node:assert/strict";
import { mockFetch, status, json } from "./biz-helpers.js";
import { htmlToMarkdown, robotsAllows, dropElements, read } from "../lib/read.js";
import { parseEmail, suggestDomain, isDisposable, isRoleAccount, emailCheck } from "../lib/email.js";
import { parseRdap, normalizeDomain, domain } from "../lib/domain.js";
import { mintInfo, flagsFor, poolRows, tokenRow, solanaToken, solanaTrending } from "../lib/solana.js";

// Calls a tool handler the way lib/app.js does: an error's status is what the buyer gets (and is never settled).
const TOOLS = { "/api/read": read, "/api/email-check": emailCheck, "/api/domain": domain, "/api/solana/token": solanaToken };
const callTool = async (path) => {
  const u = new URL(path, "https://x.test");
  try { const body = await TOOLS[u.pathname](Object.fromEntries(u.searchParams), {}); return { status: 200, json: async () => body }; }
  catch (e) { return { status: e.status >= 400 && e.status < 600 ? e.status : 400, json: async () => ({ error: e.message }) }; }
};

const html = (body, head = "<title>T</title>") => new Response(`<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
const doh = (answers) => json({ Status: 0, Answer: answers });

test("read: main content as Markdown, menus and cookie banners dropped, links absolute", () => {
  const page = `<nav><a href="/">Home</a></nav><div class="cookie-banner">We use cookies</div>
    <article><h1>Hello  world</h1><p>First <strong>bold</strong> line with a <a href="/docs?a=1">link</a>.</p>
    <div class="share">Share on X</div><ul><li>one</li><li>two</li></ul><pre><code>const x = 1;\n  y();</code></pre>
    <p>${"filler text ".repeat(30)}</p></article><footer>Footer</footer>`;
  const { markdown, links } = htmlToMarkdown(page, "https://ex.com/a/b");
  assert.match(markdown, /^# Hello world/);
  assert.match(markdown, /First \*\*bold\*\* line with a \[link\]\(https:\/\/ex\.com\/docs\?a=1\)/);
  assert.match(markdown, /- one\n- two/);
  assert.match(markdown, /```\nconst x = 1;\n  y\(\);\n```/);
  assert.doesNotMatch(markdown, /cookies|Share on X|Footer|Home/);
  assert.deepEqual(links, [{ text: "link", url: "https://ex.com/docs?a=1" }]);
});

test("read: nested boilerplate is removed with its children, tags balanced", () => {
  assert.equal(dropElements(`<div>a<div class="menu"><div>x</div><div>y</div></div>b</div>`, (t, o) => /menu/.test(o)), "<div>a b</div>".replace(" ", ""));
});

test("read: robots.txt longest match wins, our agent group before *", () => {
  const txt = "User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: SiteCheckReader\nDisallow: /no-bots";
  assert.equal(robotsAllows(txt, "/private/x"), true, "our own group replaces *");
  assert.equal(robotsAllows(txt, "/no-bots/1"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /private\nAllow: /private/ok", "/private/ok/1"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /private\nAllow: /private/ok", "/private/x"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow:", "/anything"), true);
});

test("GET /api/read returns Markdown and metadata; a robots.txt block is a 403 (not charged)", async (t) => {
  mockFetch(t, [
    ["ex.com/robots.txt", () => new Response("User-agent: *\nDisallow: /secret", { headers: { "content-type": "text/plain" } })],
    ["ex.com/post", () => html(`<main><h1>Post</h1><p>${"word ".repeat(80)}</p></main>`, `<title>Post | Ex</title><meta name="description" content="About it"><link rel="canonical" href="/post">`)],
  ]);
  const res = await callTool("/api/read?url=https://ex.com/post");
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.title, "Post | Ex");
  assert.equal(b.description, "About it");
  assert.equal(b.canonical, "https://ex.com/post");
  assert.equal(b.lang, "en");
  assert.match(b.content, /^# Post\n\nword word/);
  assert.equal(b.truncated, false);
  const blocked = await callTool("/api/read?url=https://ex.com/secret/1");
  assert.equal(blocked.status, 403);
});

test("GET /api/read refuses private addresses and non-HTML (400/415)", async (t) => {
  mockFetch(t, [["robots.txt", status(404)], ["ex.com/file.pdf", new Response("%PDF", { headers: { "content-type": "application/pdf" } })]]);
  assert.equal((await callTool("/api/read?url=http://127.0.0.1/admin")).status, 400);
  assert.equal((await callTool("/api/read?url=https://ex.com/file.pdf")).status, 415);
});

test("email: syntax, typo, disposable and role helpers", () => {
  assert.equal(parseEmail("<Maria.Garcia@Gmail.com>").normalized, "Maria.Garcia@gmail.com");
  assert.equal(parseEmail("a@@b.com").problem, "multiple-at-signs");
  assert.equal(parseEmail("john@localhost").problem, "domain-without-dot");
  assert.equal(suggestDomain("gmial.com"), "gmail.com");
  assert.equal(suggestDomain("gmail.com"), null);
  assert.equal(suggestDomain("acme.con"), "acme.com");
  assert.equal(isDisposable("sub.mailinator.com"), true);
  assert.equal(isRoleAccount("no-reply"), true);
  assert.equal(isRoleAccount("maria"), false);
});

test("GET /api/email-check: verdicts for a batch; DNS down for every address is a 503", async (t) => {
  mockFetch(t, [
    [/name=gmail\.com&type=MX/, doh([{ type: 15, data: "5 gmail-smtp-in.l.google.com." }])],
    [/name=mailinator\.com&type=MX/, doh([{ type: 15, data: "10 mail.mailinator.com." }])],
    [/name=nomail\.example&type=MX/, json({ Status: 3 })],
    [/name=nullmx\.org&type=MX/, doh([{ type: 15, data: "0 ." }])],
  ]);
  const b = await (await callTool("/api/email-check?emails=maria@gmail.com,x@mailinator.com,a@nomail.example,b@nullmx.org,not-an-email")).json();
  const v = Object.fromEntries(b.results.map((r) => [r.email, [r.verdict, r.reasons[0]]]));
  assert.deepEqual(v["maria@gmail.com"], ["unknown", undefined]);
  assert.deepEqual(v["x@mailinator.com"], ["risky", "disposable-domain"]);
  assert.deepEqual(v["a@nomail.example"], ["invalid", "domain-not-found"]);
  assert.deepEqual(v["b@nullmx.org"], ["invalid", "null-mx"]);
  assert.deepEqual(v["not-an-email"], ["invalid", "syntax:missing-at-sign"]);
  assert.deepEqual(b.counts, { unknown: 1, risky: 1, invalid: 3 });
});

test("GET /api/email-check: a single address answers flat; DNS down is 503; too many is 400", async (t) => {
  mockFetch(t, [[/dns/, status(500)], [/1\.1\.1\.1/, status(500)]]);
  assert.equal((await callTool("/api/email-check?email=a@b.com")).status, 503);
  assert.equal((await callTool(`/api/email-check?emails=${Array(51).fill("a@b.com").join(",")}`)).status, 400);
  assert.equal((await callTool("/api/email-check")).status, 400);
});

test("domain: RDAP parsing and normalisation", () => {
  assert.equal(normalizeDomain("https://WWW.Example.com/path"), "example.com");
  assert.equal(normalizeDomain("10.0.0.1"), null);
  const r = parseRdap({ events: [{ eventAction: "registration", eventDate: "2001-01-13T00:12:14Z" }, { eventAction: "expiration", eventDate: "2027-01-13T00:12:14Z" }], status: ["client transfer prohibited"], secureDNS: { delegationSigned: false }, nameservers: [{ ldhName: "NS1.EXAMPLE.ORG." }], entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "MarkMonitor Inc."]]], publicIds: [{ type: "IANA Registrar ID", identifier: "292" }] }, { roles: ["registrant"], vcardArray: ["vcard", [["org", {}, "text", "REDACTED FOR PRIVACY"]]] }] });
  assert.deepEqual([r.registrar, r.registrarIanaId, r.createdAt, r.expiresAt, r.nameServers, r.dnssec, r.registrantOrganisation], ["MarkMonitor Inc.", "292", "2001-01-13T00:12:14.000Z", "2027-01-13T00:12:14.000Z", ["ns1.example.org"], false, null]);
});

test("GET /api/domain: registered via RDAP with DNS; available on 404", async (t) => {
  mockFetch(t, [
    ["data.iana.org/rdap/dns.json", { services: [[["com", "org"], ["https://rdap.example-registry.test/"]]] }],
    [/rdap\.example-registry\.test\/domain\/taken\.com/, { events: [{ eventAction: "registration", eventDate: "2020-01-01T00:00:00Z" }, { eventAction: "expiration", eventDate: "2030-01-01T00:00:00Z" }], entities: [] }],
    [/rdap\.example-registry\.test\/domain\/free-name\.com/, status(404)],
    [/name=taken\.com&type=A$/, doh([{ type: 1, data: "93.184.216.34" }])],
    [/name=taken\.com&type=MX/, doh([{ type: 15, data: "10 mx.taken.com." }])],
    [/type=(A|AAAA|MX|NS)$/, json({ Status: 3 })],
  ]);
  const b = await (await callTool("/api/domain?domain=taken.com")).json();
  assert.deepEqual([b.registered, b.availability, b.createdAt, b.dns.resolves, b.dns.mx], [true, "registered", "2020-01-01T00:00:00.000Z", true, ["mx.taken.com"]]);
  assert.ok(b.daysUntilExpiry > 1000);
  const f = await (await callTool("/api/domain?domain=free-name.com")).json();
  assert.deepEqual([f.registered, f.availability], [false, "available"]);
  assert.equal((await callTool("/api/domain?domain=nope")).status, 400);
});

test("solana: mint facts, Jupiter rows and red flags", () => {
  const m = mintInfo({ owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { type: "mint", info: { decimals: 6, supply: "1000000000", mintAuthority: "Abc", freezeAuthority: null } } } });
  assert.deepEqual([m.program, m.supply, m.mintAuthorityEnabled, m.freezeAuthorityEnabled], ["spl-token", 1000, true, false]);
  assert.equal(mintInfo({ data: { parsed: { type: "account" } } }), null);
  const r = tokenRow({ id: "Mint1", name: "A", symbol: "A", usdPrice: 0.5, liquidity: 5000, holderCount: 120, firstPool: { createdAt: "2026-10-08T00:00:00Z" }, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false, topHoldersPercentage: 71.3 }, stats24h: { buyVolume: 700, sellVolume: 300, numBuys: 40, numSells: 0 }, organicScoreLabel: "low" }, Date.parse("2026-10-08T12:00:00Z"));
  assert.deepEqual([r.volume24hUsd, r.ageHours, r.mintAuthorityEnabled, r.freezeAuthorityEnabled, r.topHoldersPercent], [1000, 12, false, true, 71.3]);
  assert.deepEqual(flagsFor(r).map((f) => f.split(":")[0]), ["freeze-authority-enabled", "concentrated", "low-liquidity", "new", "no-sells-in-24h", "low-organic-score"]);
  assert.deepEqual(flagsFor(r, m).map((f) => f.split(":")[0]).slice(0, 2), ["mint-authority-enabled", "concentrated"], "on-chain facts win over the API's audit");
  const [p] = poolRows({ data: [{ type: "pool", attributes: { address: "P1", name: "A / SOL", reserve_in_usd: "60000", volume_usd: { h24: "1000" } }, relationships: { dex: { data: { id: "raydium" } } } }] });
  assert.deepEqual([p.liquidityUsd, p.dex], [60000, "raydium"]);
});

test("GET /api/solana/token: bad address is 400, a wallet (not a mint) is 400", async (t) => {
  mockFetch(t, [
    ["api.geckoterminal.com", status(404)],
    ["lite-api.jup.ag", []],
    [/publicnode|mainnet-beta/, { jsonrpc: "2.0", result: { value: { owner: "11111111111111111111111111111111", data: ["", "base64"] } } }],
  ]);
  assert.equal((await callTool("/api/solana/token?address=nope")).status, 400);
  assert.equal((await callTool("/api/solana/token?address=9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")).status, 400);
});

test("GET /api/solana/trending filters by liquidity and adds flags", async (t) => {
  mockFetch(t, [["lite-api.jup.ag/tokens/v2/toptrending/1h", [
    { id: "A1", symbol: "BIG", liquidity: 900000, stats24h: { buyVolume: 10, sellVolume: 10 }, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } },
    { id: "B2", symbol: "TINY", liquidity: 900 },
  ]]]);
  const b = await solanaTrending({ mode: "trending" });
  assert.deepEqual([b.looked, b.returned, b.results[0].symbol, b.results[0].flags], [2, 1, "BIG", []]);
});
