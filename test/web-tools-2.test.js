import { test } from "node:test";
import assert from "node:assert/strict";
import { mockFetch, status, json } from "./biz-helpers.js";
import { fx } from "../lib/fx.js";
import { parseSitemap, sitemap } from "../lib/sitemap.js";
import { pageSignals, detectTechnologies, summarize } from "../lib/tech.js";
import { pdf } from "../lib/pdf.js";
import { solanaWallet } from "../lib/solana.js";

const statusOf = async (p) => { try { await p; return 200; } catch (e) { return e.status ?? 400; } };

test("fx: latest rates with conversion; bad codes are 400 before any call", async (t) => {
  const calls = mockFetch(t, [["api.frankfurter.dev/v1/latest?base=USD&symbols=EUR%2CTRY", { amount: 1, base: "USD", date: "2026-10-08", rates: { EUR: 0.9, TRY: 49.2 } }]]);
  const r = await fx({ from: "usd", to: "eur,try", amount: "100" });
  assert.deepEqual([r.base, r.date, r.converted], ["USD", "2026-10-08", { EUR: 90, TRY: 4920 }]);
  assert.equal(await statusOf(fx({ to: "EURO" })), 400);
  assert.equal(await statusOf(fx({ end: "2026-01-01" })), 400);
  assert.equal(calls.length, 1);
});

test("sitemap: urlset and index parsing; robots.txt sitemap followed through an index", async (t) => {
  const idx = parseSitemap(`<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>`);
  assert.deepEqual([idx.kind, idx.entries[0].loc], ["index", "https://a.test/s1.xml"]);
  mockFetch(t, [
    ["a.test/robots.txt", () => new Response("User-agent: *\nSitemap: https://a.test/index.xml")],
    ["a.test/index.xml", () => new Response(`<?xml version="1.0"?><sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>`)],
    ["a.test/s1.xml", () => new Response(`<urlset><url><loc>https://a.test/blog/new</loc><lastmod>2026-10-07</lastmod></url><url><loc>https://a.test/blog/old?a=1&amp;b=2</loc><lastmod>2025-01-01</lastmod></url><url><loc>https://a.test/about</loc></url></urlset>`)],
  ]);
  const r = await sitemap({ url: "a.test", pathPrefix: "/blog/" });
  assert.deepEqual(r.urls, [{ url: "https://a.test/blog/new", lastmod: "2026-10-07" }, { url: "https://a.test/blog/old?a=1&b=2", lastmod: "2025-01-01" }]);
  assert.equal(r.sitemapsRead, 2);
  const since = await sitemap({ url: "a.test", since: "2026-01-01" });
  assert.deepEqual(since.urls.map((u) => u.url), ["https://a.test/blog/new"]);
});

test("sitemap: no sitemap anywhere is a 404 (not charged)", async (t) => {
  mockFetch(t, [[/b\.test/, () => status(404)]]);
  assert.equal(await statusOf(sitemap({ url: "b.test" })), 404);
});

test("tech: fingerprints over markup, headers, cookies and DNS", () => {
  const html = `<html><head><meta name="generator" content="WordPress 6.6.2"><script src="https://www.googletagmanager.com/gtm.js?id=GTM-X"></script><link rel="stylesheet" href="/wp-content/themes/x/style.css"></head><body><a href="https://stripe.com">we like stripe</a></body></html>`;
  const s = { ...pageSignals(html, new Headers({ server: "nginx/1.25" }), []), mx: ["aspmx.l.google.com"], txt: [] };
  const list = detectTechnologies(s);
  const names = list.map((x) => x.name);
  assert.ok(names.includes("WordPress") && names.includes("Google Tag Manager") && names.includes("Google Workspace"), names.join(","));
  assert.ok(!names.includes("Stripe"), "a plain link is not evidence");
  assert.equal(list.find((x) => x.name === "WordPress").version, "6.6.2");
  const sum = summarize(list);
  assert.deepEqual([sum.cms, sum.emailProvider], ["WordPress", "Google Workspace"]);
});

test("pdf: input checks are 400 (not charged)", async (t) => {
  mockFetch(t, [["n.test/not.pdf", () => new Response("<html>hi</html>")]]);
  assert.equal(await statusOf(pdf({})), 400);
  assert.equal(await statusOf(pdf({ pdf_base64: btoa("hello world") })), 400);
  assert.equal(await statusOf(pdf({ url: "https://n.test/not.pdf" })), 400);
});

test("solana wallet: Jupiter holdings, prices and names; dust hidden", async (t) => {
  mockFetch(t, [
    ["ultra/v1/holdings/", { uiAmount: 2, uiAmountString: "2", tokens: { MintUsdc: [{ amount: "5000000", uiAmountString: "5", decimals: 6, programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }], MintDust: [{ amount: "1", uiAmountString: "0.000001", decimals: 6 }] } }],
    ["price/v3", { So11111111111111111111111111111111111111112: { usdPrice: 100 }, MintUsdc: { usdPrice: 1 }, MintDust: { usdPrice: 0.5 } }],
    ["tokens/v2/search", [{ id: "MintUsdc", symbol: "USDC", name: "USD Coin", isVerified: true }]],
  ]);
  const r = await solanaWallet({ address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }, {});
  assert.deepEqual([r.sol.valueUsd, r.totalValueUsd, r.tokensShown, r.hiddenDustOrUnpriced, r.tokens[0].symbol], [200, 205, 1, 1, "USDC"]);
  assert.equal(await statusOf(solanaWallet({ address: "0xabc" }, {})), 400);
});
