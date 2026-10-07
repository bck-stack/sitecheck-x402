import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, mockFetch, status } from "./biz-helpers.js";
import { leiChecksumOk, looksLikeLei, score, kycSummary } from "../lib/lei.js";

const rec = (lei, name, over = {}) => ({ id: lei, type: "lei-records", attributes: {
  lei, entity: { legalName: { name, language: "en" }, otherNames: [], legalAddress: { addressLines: ["1 Main St"], city: "Berlin", region: "DE-BE", country: "DE", postalCode: "10115" }, headquartersAddress: { addressLines: ["1 Main St"], city: "Berlin", country: "DE", postalCode: "10115" }, registeredAt: { id: "RA000242" }, registeredAs: "HRB 1", jurisdiction: "DE", category: "GENERAL", legalForm: { id: "XLWI" }, status: "ACTIVE" },
  registration: { status: "ISSUED", initialRegistrationDate: "2020-01-01T00:00:00Z", lastUpdateDate: "2026-06-01T00:00:00Z", nextRenewalDate: "2027-06-01T00:00:00Z", managingLou: "529900T8BM49AURSDO55", corroborationLevel: "FULLY_CORROBORATED" },
  ...over } });
const NOT_FOUND = () => status(404, { errors: [{ status: "404" }] });
const SIEMENS = "W38RGI023J3WT1HWRP32";
const PARENT = "529900T8BM49AURSDO55";
const base = [
  [`lei-records/${SIEMENS}/direct-children`, { meta: { pagination: { total: 12 } }, data: [rec("5299000000000000AA01", "Child One GmbH"), rec("5299000000000000AA02", "Child Two GmbH")] }],
  [`lei-records/${SIEMENS}/ultimate-children`, { meta: { pagination: { total: 30 } }, data: [] }],
];

test("LEI checksum and shape", () => {
  assert.equal(leiChecksumOk(SIEMENS), true);
  assert.equal(leiChecksumOk("W38RGI023J3WT1HWRP33"), false);
  assert.equal(looksLikeLei(SIEMENS), true);
  assert.equal(looksLikeLei("Siemens AG"), false);
});

test("by LEI: record, reporting exception, children counts, kycSummary", async (t) => {
  const calls = mockFetch(t, [
    ...base,
    [`lei-records/${SIEMENS}/direct-parent-reporting-exception`, { data: { attributes: { reason: "NO_KNOWN_PERSON", category: "DIRECT_ACCOUNTING_CONSOLIDATION_PARENT" } } }],
    [`lei-records/${SIEMENS}/ultimate-parent-reporting-exception`, { data: { attributes: { reason: "NO_KNOWN_PERSON", category: "ULTIMATE_ACCOUNTING_CONSOLIDATION_PARENT" } } }],
    [/-parent$/, NOT_FOUND],
    [`lei-records/${SIEMENS}`, { data: rec(SIEMENS, "Siemens Aktiengesellschaft") }],
  ]);
  const res = await callTool(`/api/lei?q=${SIEMENS.toLowerCase()}`);
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.deepEqual([b.matchedBy, b.lei, b.legalName, b.status, b.jurisdiction], ["lei", SIEMENS, "Siemens Aktiengesellschaft", "ACTIVE", "DE"]);
  assert.equal(b.registration.nextRenewalDate, "2027-06-01");
  assert.deepEqual([b.directParent.relationship, b.directParent.reason, b.ultimateParent.reason], ["exception", "NO_KNOWN_PERSON", "NO_KNOWN_PERSON"]);
  assert.deepEqual([b.children.directCount, b.children.ultimateCount, b.children.direct.length], [12, 30, 2]);
  assert.match(b.kycSummary, /^Active, registration issued/);
  assert.match(b.kycSummary, /ultimate parent: none reported \(no known person\)/);
  assert.ok(calls.length <= 8, `subrequests: ${calls.length}`);
  assert.ok(calls.every((c) => /^SiteCheck\/1\.x/.test(c.headers["user-agent"])));
  assert.ok(calls.some((c) => c.url.includes("direct-children?page%5Bsize%5D=10")));
});

test("parents are reported with LEI and name; lapsed registration shows in the summary", async (t) => {
  mockFetch(t, [
    ...base.map(([m]) => [m, { meta: { pagination: { total: 0 } }, data: [] }]),
    [`lei-records/${SIEMENS}/direct-parent`, { data: rec(PARENT, "Parent Holding SE", { entity: { ...rec(PARENT, "x").attributes.entity, legalName: { name: "Parent Holding SE" }, legalAddress: { country: "US" } } }) }],
    [`lei-records/${SIEMENS}/ultimate-parent`, { data: rec(PARENT, "Parent Holding SE", { entity: { ...rec(PARENT, "x").attributes.entity, legalName: { name: "Parent Holding SE" }, legalAddress: { country: "US" } } }) }],
    [`lei-records/${SIEMENS}`, { data: rec(SIEMENS, "Siemens Aktiengesellschaft", { registration: { status: "LAPSED", nextRenewalDate: "2025-03-01T00:00:00Z", lastUpdateDate: "2025-01-01T00:00:00Z" } }) }],
  ]);
  const b = await (await callTool(`/api/lei?q=${SIEMENS}`)).json();
  assert.deepEqual([b.directParent.relationship, b.directParent.lei, b.directParent.name], ["reported", PARENT, "Parent Holding SE"]);
  assert.equal(b.kycSummary, "Active, registration lapsed 2025-03-01, jurisdiction DE, ultimate parent: Parent Holding SE (US)");
});

test("by name: best match first, up to 5 alternatives", async (t) => {
  const names = ["Siemens Advanta Solutions GmbH", "Siemens Aktiengesellschaft", "Siemens Aktiengesellschaft Österreich", "SHC Trust e.V.", "Siemens Beteiligungen Europa GmbH", "Siemens X", "Siemens Y"];
  const data = names.map((n, i) => rec(i === 1 ? SIEMENS : `52990000000000000${i}${String(i).padStart(2, "0")}`.slice(0, 20), n));
  mockFetch(t, [
    ...base,
    [`lei-records/${SIEMENS}/direct-parent-reporting-exception`, NOT_FOUND], [`lei-records/${SIEMENS}/ultimate-parent-reporting-exception`, NOT_FOUND], [/-parent$/, NOT_FOUND],
    ["filter%5Bentity.legalName%5D=Siemens", { data: [] }],
    ["filter%5Bfulltext%5D=Siemens", { data }],
  ]);
  const b = await (await callTool("/api/lei?q=Siemens%20Aktiengesellschaft")).json();
  assert.equal(b.matchedBy, "name");
  assert.equal(b.lei, SIEMENS);
  assert.equal(b.matchScore, 1);
  assert.equal(b.alternatives.length, 5);
  assert.equal(b.alternatives[0].name, "Siemens Aktiengesellschaft Österreich");
  assert.deepEqual([b.directParent.relationship], ["none-reported"]);
});

test("input and lookup failures: 400 bad input, 404 not found, 5xx upstream, none charged", async (t) => {
  const calls = mockFetch(t, [["lei-records/", NOT_FOUND], ["lei-records?", { data: [] }]]);
  assert.equal((await callTool("/api/lei")).status, 400);
  const badSum = await callTool("/api/lei?q=W38RGI023J3WT1HWRP33");
  assert.equal(badSum.status, 400);
  assert.match((await badSum.json()).error, /checksum/);
  assert.equal(calls.length, 0, "an invalid LEI is rejected locally");
  assert.equal((await callTool(`/api/lei?q=${SIEMENS}`)).status, 404);
  const none = await callTool("/api/lei?q=zzzz%20nothing");
  assert.equal(none.status, 404);
  assert.match((await none.json()).error, /not charged/);
  mockFetch(t, [["gleif.org", status(500)]]);
  const down = await callTool(`/api/lei?q=${SIEMENS}`);
  assert.equal(down.status, 503);
  assert.match((await down.json()).error, /not charged/);
  mockFetch(t, [["gleif.org", () => { const e = new Error("t"); e.name = "TimeoutError"; return e; }]]);
  assert.equal((await callTool(`/api/lei?q=${SIEMENS}`)).status, 503);
});

test("fuzzy scoring prefers exact and active names", () => {
  assert.equal(score("Acme Inc", "ACME, INC.", "ACTIVE"), 1);
  assert.ok(score("Acme", "Acme Holdings Ltd", "ACTIVE") > score("Acme", "Zebra Ltd", "ACTIVE"));
  assert.ok(score("Acme", "Acme Ltd", "ACTIVE") > score("Acme", "Acme Ltd", "INACTIVE"));
  assert.match(kycSummary({ status: "INACTIVE", jurisdiction: "GB", registration: { status: "ANNULLED" } }, { relationship: "none-reported" }), /^Inactive, registration annulled, jurisdiction GB/);
});
