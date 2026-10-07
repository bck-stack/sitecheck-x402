import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, mockFetch, status } from "./biz-helpers.js";
import { ukToday, typeMatcher } from "../lib/ukInsolvency.js";

const CACHE = "gazette-cache.sitecheck-api.workers.dev/events";
const ev = (id, code, type, at, companies, extra = {}) => ({
  entry: { noticeId: id, noticeCode: code, publishedAt: at, title: companies[0]?.name ?? "x", noticeTypeName: type, excerpt: "..." },
  detail: { noticeId: id, noticeCode: code, publishedAt: at, companies, practitioners: [{ name: "Jo Bloggs", firm: "Bloggs Recovery LLP" }], retractionText: null, ...extra },
});
const co = (name, number, postcode, over = {}) => ({ name, number, tradingName: null, natureOfBusiness: "Retail", typeOfLiquidation: "Creditors Voluntary Liquidation", postcode, ...over });
const today = ukToday();
const EVENTS = [
  ev("501", "2443", "Appointment of Liquidators", `${today}T10:00:00`, [co("GLO LINK LIMITED", "11075587", "MK13 7QW")]),
  ev("502", "2410", "Appointment of Administrators", `${today}T09:00:00`, [co("Big Brand Ideas Limited", "07659739", "OL8 3QL", { typeOfLiquidation: null })]),
  ev("503", "2450", "Petitions to Wind Up (Companies)", `${today}T08:00:00`, [co("SMITH & SONS LTD", "00123456", "SW1A 1AA"), co("SMITH HOLDINGS LTD", "00123457", "SW1A 2BB")]),
  ev("504", "2433", "Notices to Creditors", `${today}T07:00:00`, [co("Oddly Cased Café Ltd", "09999999", "EC1A 1BB")]),
];
// The real cache's layout: header keys first, then events, entry first in each event.
const gazette = (events = EVENTS, over = {}) => JSON.stringify({ dataTimestamp: "2026-10-06T21:33:05.005Z", from: "x", to: "y", windowFrom: "x", windowTo: "y", noticeCodes: ["2443"], coveredDays: [today], missingDays: [], incompleteDays: [], count: events.length, events, ...over });
// Answers like the cache: only the events inside ?from=..&to=.. (both days included).
const fresh = (events = EVENTS, over) => [CACHE, (call) => {
  const u = new URL(call.url), from = u.searchParams.get("from"), to = u.searchParams.get("to");
  const inside = events.filter((e) => e.entry.publishedAt.slice(0, 10) >= from && e.entry.publishedAt.slice(0, 10) <= to);
  return new Response(gazette(inside, over), { headers: { "content-type": "application/json" } });
}];

test("happy path: rows with company, number, type, date, postcode, link and cache metadata", async (t) => {
  const calls = mockFetch(t, [fresh()]);
  const res = await callTool("/api/uk-insolvency");
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.results.length, 5, "a notice naming two companies gives two rows");
  assert.deepEqual(b.results[0], { company: "GLO LINK LIMITED", companyNumber: "11075587", noticeType: "Appointment of Liquidators", noticeCode: "2443", date: today, publishedAt: `${today}T10:00:00`, natureOfBusiness: "Retail", typeOfLiquidation: "Creditors Voluntary Liquidation", postcode: "MK13 7QW", practitioners: ["Bloggs Recovery LLP"], noticeId: "501", link: "https://www.thegazette.co.uk/notice/501" });
  assert.equal(b.dataTimestamp, "2026-10-06T21:33:05.005Z");
  assert.deepEqual(b.missingDays, []);
  assert.equal(b.total, 5);
  assert.ok(calls.every((c) => c.url.startsWith("https://gazette-cache.sitecheck-api.workers.dev/") && !c.url.includes("thegazette.co.uk")));
  assert.match(calls[0].headers["user-agent"], /^SiteCheck\/1\.x/);
  assert.ok(b.notes.some((n) => /COMPANIES_HOUSE_API_KEY/.test(n)), "says enrichment is off");
});

test("missingDays and the window are reported; since is clipped to the cache window", async (t) => {
  const calls = mockFetch(t, [fresh(EVENTS, { missingDays: [today], coveredDays: [] })]);
  const b = await (await callTool("/api/uk-insolvency?since=2020-01-01&q=glo")).json();
  assert.deepEqual(b.missingDays, [today]);
  assert.ok(b.notes.some((n) => /does not cover|no data for/.test(n) && n.includes(today)));
  assert.ok(b.notes.some((n) => /since clipped/.test(n)));
  assert.notEqual(b.query.since, "2020-01-01");
  const from = new URL(calls[0].url).searchParams.get("from");
  assert.equal(from, b.query.since);
});

test("filters: company name (any case), company number, postcode prefix, notice type, limit", async (t) => {
  mockFetch(t, [fresh()]);
  const names = async (q) => (await (await callTool(`/api/uk-insolvency?${q}`)).json()).results.map((r) => r.companyNumber);
  assert.deepEqual(await names("q=glo%20link"), ["11075587"]);
  assert.deepEqual(await names("q=SMITH"), ["00123456", "00123457"]);
  assert.deepEqual(await names("q=smith%20%26%20sons"), ["00123456"]);
  assert.deepEqual(await names("q=oddly%20cased%20caf%C3%A9"), ["09999999"], "mixed-case names are found");
  assert.deepEqual(await names("q=zzzz"), []);
  assert.deepEqual(await names("q=11075587"), ["11075587"]);
  assert.deepEqual(await names("q=123456"), ["00123456"]);
  assert.deepEqual(await names("postcode=sw1a"), ["00123456", "00123457"]);
  assert.deepEqual(await names("postcode=SW1A%202"), ["00123457"]);
  assert.deepEqual(await names("postcode=MK13%207QW"), ["11075587"]);
  assert.deepEqual(await names("type=administration"), ["07659739"]);
  assert.deepEqual(await names("type=liquidation"), ["11075587"]);
  assert.deepEqual(await names("type=petition"), ["00123456", "00123457"]);
  assert.deepEqual(await names("type=2433"), ["09999999"]);
  assert.equal((await names("limit=2")).length, 2);
  const limited = await (await callTool("/api/uk-insolvency?limit=2")).json();
  assert.equal(limited.moreAvailable, true);
});

test("Companies House enrichment: only with the key, Basic auth with the key as username, at most 10 rows", async (t) => {
  const many = Array.from({ length: 14 }, (_, i) => ev(`6${i}`, "2443", "Appointment of Liquidators", `${today}T${String(10 + (i % 9)).padStart(2, "0")}:00:00`, [co(`ACME ${i} LTD`, String(1000000 + i), "AB1 2CD")]));
  const calls = mockFetch(t, [
    ["api.company-information.service.gov.uk/company/1000003", status(404)],
    ["api.company-information.service.gov.uk/company/", (c) => ({ company_name: "ACME", company_status: "liquidation", type: "ltd", date_of_creation: "2010-05-01", sic_codes: ["47110"], registered_office_address: { address_line_1: "1 High St", locality: "Leeds", postal_code: "LS1 1AA" }, has_insolvency_history: true })],
    fresh(many),
  ]);
  const b = await (await callTool("/api/uk-insolvency?limit=50", { COMPANIES_HOUSE_API_KEY: "ch-key" })).json();
  const ch = calls.filter((c) => c.url.includes("company-information"));
  assert.equal(ch.length, 10);
  assert.equal(ch[0].headers.authorization, `Basic ${Buffer.from("ch-key:").toString("base64")}`);
  assert.equal(b.results.filter((r) => r.companiesHouse).length, 10);
  const enriched = b.results.find((r) => r.companiesHouse?.found);
  assert.deepEqual([enriched.companiesHouse.status, enriched.companiesHouse.incorporated, enriched.companiesHouse.sicCodes, enriched.companiesHouse.registeredAddress], ["liquidation", "2010-05-01", ["47110"], "1 High St, Leeds, LS1 1AA"]);
  assert.equal(b.companiesHouse.enriched, 10);
  assert.ok(calls.length <= 14, "at most 4 cache reads and 10 Companies House lookups");
  const none = await callTool("/api/uk-insolvency");
  assert.ok(!JSON.stringify(await none.json()).includes("companiesHouse\":{"), "no enrichment without the key");
});

test("a Companies House failure does not fail the call", async (t) => {
  mockFetch(t, [["company-information", status(500)], fresh()]);
  const res = await callTool("/api/uk-insolvency?q=glo", { COMPANIES_HOUSE_API_KEY: "ch-key" });
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.results.length, 1);
  assert.equal(b.companiesHouse.failed, 1);
});

test("cache down, slow or garbled: 5xx, not charged", async (t) => {
  mockFetch(t, [[CACHE, status(500)]]);
  const r1 = await callTool("/api/uk-insolvency");
  assert.equal(r1.status, 503);
  assert.match((await r1.json()).error, /not charged/);
  mockFetch(t, [[CACHE, () => { const e = new Error("t"); e.name = "TimeoutError"; return e; }]]);
  assert.equal((await callTool("/api/uk-insolvency")).status, 503);
  mockFetch(t, [[CACHE, new Response("<html>oops</html>")]]);
  assert.equal((await callTool("/api/uk-insolvency")).status, 502);
});

test("bad input is 400 and the cache is not called", async (t) => {
  const calls = mockFetch(t, []);
  for (const q of ["since=last-week", "since=2999-01-01", "postcode=%21%21"]) assert.equal((await callTool(`/api/uk-insolvency?${q}`)).status, 400, q);
  assert.equal(calls.length, 0);
});

test("type matcher", () => {
  assert.equal(typeMatcher("administration")("2410", "Appointment of Administrators"), true);
  assert.equal(typeMatcher("winding-up")("2431", "Resolutions for Winding-up"), true);
  assert.equal(typeMatcher("2410")("2410", "x"), true);
  assert.equal(typeMatcher("2410")("2411", "x"), false);
});
