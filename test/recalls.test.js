import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, mockFetch, status } from "./biz-helpers.js";
import { fdaStates, cpscSeverity } from "../lib/recalls.js";

const fda = (n, cls, over = {}) => ({ recall_number: `F-${n}-2026`, event_id: `9${n}`, classification: cls, recalling_firm: "Example Foods Inc.", product_description: "Peanut butter cookies, 12 oz", reason_for_recall: "Undeclared milk allergen", report_date: "20260930", recall_initiation_date: "20260912", status: "Ongoing", distribution_pattern: "Distributed in TX, CA and NY.", city: "Austin", state: "TX", ...over });
const cpsc = (id, date, hazard, over = {}) => ({ RecallID: id, RecallNumber: `27${id}`, RecallDate: `${date}T00:00:00`, Title: "Example Recalls Space Heaters", URL: `https://www.cpsc.gov/Recalls/2026/example-${id}`, Products: [{ Name: "Example space heater", Type: "Heaters", NumberOfUnits: "About 5,000" }], Manufacturers: [{ Name: "Example Corp." }], Hazards: [{ Name: hazard }], Injuries: [{ Name: "None reported" }], Retailers: [{ Name: "Sold at Walmart nationwide" }], RemedyOptions: [{ Option: "Refund" }], ...over });
const FDA_ROUTES = (rows = {}) => ["food", "drug", "device"].map((k) => [`api.fda.gov/${k}/enforcement.json`, { results: rows[k] ?? [] }]);

test("one schema over FDA and CPSC, newest first, with the class-to-severity mapping", async (t) => {
  const calls = mockFetch(t, [...FDA_ROUTES({ food: [fda(1, "Class I"), fda(2, "Class II", { report_date: "20260929" })], drug: [fda(3, "Class III", { report_date: "20260928" })] }),
    ["saferproducts.gov", [cpsc(11, "2026-10-01", "The heater can overheat, posing a fire hazard.")]]]);
  const res = await callTool("/api/recalls?since=2026-09-01&limit=10");
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.total, 4);
  assert.deepEqual(b.results.map((r) => [r.source, r.id, r.severity]), [["cpsc", "2711", "high"], ["fda", "F-1-2026", "high"], ["fda", "F-2-2026", "medium"], ["fda", "F-3-2026", "low"]]);
  const f = b.results[1];
  assert.deepEqual([f.category, f.firm, f.classification, f.date, f.reason], ["food", "Example Foods Inc.", "Class I", "2026-09-30", "Undeclared milk allergen"]);
  assert.deepEqual(f.states, ["TX", "CA", "NY"]);
  assert.match(f.link, /ires\/index\.cfm\?Event=91$/);
  const c = b.results[0];
  assert.deepEqual([c.firm, c.units, c.remedy, c.nationwide, c.link], ["Example Corp.", "About 5,000", ["Refund"], true, "https://www.cpsc.gov/Recalls/2026/example-11"]);
  assert.match(b.severityNote, /derived from the hazard text/);
  assert.equal(calls.length, 4, "3 FDA categories + 1 CPSC call");
  assert.ok(calls.every((c) => /^SiteCheck\/1\.x/.test(c.headers["user-agent"]) && c.signal));
});

test("filters reach the upstream queries: keyword, classification, since, limit", async (t) => {
  const calls = mockFetch(t, [...FDA_ROUTES({ food: [fda(1, "Class I")] }), ["saferproducts.gov", []]]);
  const res = await callTool("/api/recalls?q=peanut%20butter&source=fda&classification=Class%20I&since=2026-09-01&limit=500");
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
  const u = decodeURIComponent(calls[0].url);
  assert.match(u, /report_date:\[20260901\+TO\+\d{8}\]/);
  assert.match(u, /product_description:\(peanut\+AND\+butter\)\+OR\+recalling_firm:\(peanut\+AND\+butter\)/);
  assert.match(u, /classification:"Class I"/);
  assert.match(u, /limit=100/, "limit is capped at 100");
  const only = await (await callTool("/api/recalls?source=fda&classification=high")).json();
  assert.deepEqual(only.query.source, ["fda"]);
});

test("CPSC keyword search merges the title, product and description queries", async (t) => {
  const calls = mockFetch(t, [["ProductName=toy", [cpsc(1, "2026-09-20", "x")]], ["RecallTitle=toy", [cpsc(1, "2026-09-20", "x"), cpsc(2, "2026-09-21", "choking hazard")]], ["RecallDescription=toy", []]]);
  const b = await (await callTool("/api/recalls?source=cpsc&q=toy")).json();
  assert.equal(calls.length, 3);
  assert.equal(b.total, 2, "duplicates removed");
});

test("classification filter on CPSC uses derived severity", async (t) => {
  mockFetch(t, [["saferproducts.gov", [cpsc(1, "2026-09-20", "fire hazard"), cpsc(2, "2026-09-21", "minor cosmetic issue", { Title: "Example Recalls Mugs" })]]]);
  const b = await (await callTool("/api/recalls?source=cpsc&classification=low")).json();
  assert.deepEqual(b.results.map((r) => r.id), ["272"]);
  assert.equal(cpscSeverity("risk of serious injury or death"), "high");
  assert.equal(cpscSeverity("cuts"), "medium");
  assert.deepEqual(fdaStates("TX, CA and Nationwide"), { states: ["TX", "CA"], nationwide: true });
});

test("openFDA answering 404 means no matches, not an error", async (t) => {
  mockFetch(t, ["food", "drug", "device"].map((k) => [`api.fda.gov/${k}/`, status(404, { error: { code: "NOT_FOUND" } })]));
  const res = await callTool("/api/recalls?source=fda&q=zzzz");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).total, 0);
});

test("bad input is 400", async (t) => {
  const calls = mockFetch(t, []);
  for (const q of ["source=nhtsa", "classification=Class%20IV", "since=yesterday", "since=2999-01-01"]) assert.equal((await callTool(`/api/recalls?${q}`)).status, 400, q);
  assert.equal(calls.length, 0);
});

test("any failing source is a 503 (nothing partial is sold)", async (t) => {
  mockFetch(t, [...FDA_ROUTES(), ["saferproducts.gov", status(500)]]);
  const res = await callTool("/api/recalls");
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /CPSC.*not charged/);
  mockFetch(t, [["api.fda.gov/food", status(500)], ["api.fda.gov/drug", { results: [] }], ["api.fda.gov/device", { results: [] }]]);
  assert.equal((await callTool("/api/recalls?source=fda")).status, 503);
  mockFetch(t, [["saferproducts.gov", () => { const e = new Error("t"); e.name = "TimeoutError"; return e; }]]);
  assert.equal((await callTool("/api/recalls?source=cpsc")).status, 503);
});

test("long date ranges are clipped, not rejected", async (t) => {
  mockFetch(t, [...FDA_ROUTES(), ["saferproducts.gov", []]]);
  const b = await (await callTool("/api/recalls?since=2001-01-01")).json();
  assert.ok(b.notes.some((n) => /clipped/.test(n)));
  assert.ok(b.notes.some((n) => /CPSC without a keyword/.test(n)));
});
