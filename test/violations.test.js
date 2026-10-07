import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, mockFetch, status } from "./biz-helpers.js";
import { chunkIds, dolUrl } from "../lib/violations.js";

const KEY = "dol-test-key";
const inspection = (id, over = {}) => ({ activity_nr: id, estab_name: "ACME PLANT", site_state: "TX", site_city: "HOUSTON", open_date: "2026-08-12T00:00:00", insp_type: "B", close_case_date: null, ...over });
const facilities = { Results: { QueryID: "1", QueryRows: "1" } };
const echo = (n) => `echodata.epa.gov/echo/${n}`;
const EPA = [
  [echo("echo_rest_services.get_facilities"), facilities],
  [echo("echo_rest_services.get_qid"), { Results: { Facilities: [{ FacName: "ACME PLANT", FacState: "TX", FacCity: "HOUSTON", RegistryID: "110000000001", FacFormalActionCount: "2", FacTotalPenalties: "$50,000" }, { FacName: "NO ACTIONS", RegistryID: "110000000002", FacFormalActionCount: "0", FacTotalPenalties: "$0" }] } }],
  [echo("case_rest_services.get_cases"), { Results: { QueryID: "9", QueryRows: "1" } }],
  [echo("case_rest_services.get_qid"), { Results: { Cases: [{ CaseNumber: "06-2025-0001", CaseName: "Acme Chemical LLC", CaseCategoryDesc: "Administrative - Formal", PrimaryLaw: "CAA", PrimarySection: "112", EnfOutcome: "Final Order With Penalty", DateFiled: "03/04/2026", SettlementDate: "03/04/2026", FedPenalty: "$50,000.00", StateLocPenaltyAmt: "$0.00", CaseStatusDesc: "Resolved" }, { CaseNumber: "06-2019-0002", CaseName: "Acme Old Case", DateFiled: "01/01/2019", FedPenalty: "$900.00" }] } }],
];

test("without DOL_API_KEY: EPA only, with a note that OSHA is off", async (t) => {
  const calls = mockFetch(t, EPA);
  const res = await callTool("/api/violations?company=Acme&state=TX&since=2025-01-01");
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.deepEqual(b.query.sources, ["epa"]);
  assert.ok(b.notes.some((n) => /OSHA is off.*DOL_API_KEY/.test(n)));
  assert.equal(b.total, 1, "the 2019 case is older than since");
  assert.deepEqual([b.results[0].id, b.results[0].penalty, b.results[0].date, b.results[0].link], ["06-2025-0001", 50000, "2026-03-04", "https://echo.epa.gov/enforcement-case-report?id=06-2025-0001"]);
  assert.match(b.results[0].type, /CAA §112/);
  assert.ok(!calls.some((c) => c.url.includes("dol.gov")), "DOL is never called without a key");
  // only facilities with formal actions get a case lookup
  assert.equal(calls.filter((c) => c.url.includes("get_cases")).length, 1);
  assert.ok(calls.length < 50);
});

test("OSHA: key goes in X-API-KEY, penalties are summed from violations, link is the inspection detail", async (t) => {
  const calls = mockFetch(t, [
    ["/OSHA/inspection/json", { data: [inspection("1001"), inspection("1002", { open_date: "2026-09-01T00:00:00" })] }],
    ["/OSHA/violation/json", { data: [{ activity_nr: "1001", current_penalty: "4000.00", viol_type: "S" }, { activity_nr: "1001", current_penalty: "1500.50", viol_type: "O" }, { activity_nr: "1002", current_penalty: "0", viol_type: "O" }] }],
  ]);
  const res = await callTool("/api/violations?company=Acme&state=tx&source=osha&since=2026-01-01", { DOL_API_KEY: KEY });
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.deepEqual(b.results.map((r) => [r.id, r.penalty]), [["1002", 0], ["1001", 5500.5]]);
  assert.equal(b.results[1].link, "https://www.osha.gov/ords/imis/establishment.inspection_detail?id=1001");
  assert.match(b.results[1].type, /Serious violation/);
  const first = new URL(calls[0].url);
  assert.equal(first.searchParams.get("X-API-KEY"), KEY);
  const f = JSON.parse(first.searchParams.get("filter_object"));
  assert.deepEqual(f.and.map((x) => [x.field, x.operator, x.value]), [["open_date", "gt", "2026-01-01"], ["estab_name", "like", "Acme"], ["site_state", "eq", "TX"]]);
  assert.match(calls[0].headers["user-agent"], /^SiteCheck\/1\.x/);
});

test("DOL answering HTTP 204 means no records: empty result, no violation lookup", async (t) => {
  const calls = mockFetch(t, [["/OSHA/inspection/json", new Response(null, { status: 204 })]]);
  const res = await callTool("/api/violations?company=Nobody&source=osha", { DOL_API_KEY: KEY });
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.deepEqual([b.total, b.results], [0, []]);
  assert.equal(calls.length, 1);
});

test("violation lookups are chunked so no DOL URL exceeds ~2,000 characters, and capped", async (t) => {
  const ids = Array.from({ length: 100 }, (_, i) => String(317000000 + i * 17));
  const calls = mockFetch(t, [
    ["/OSHA/inspection/json", { data: ids.map((id) => inspection(id)) }],
    ["/OSHA/violation/json", { data: [] }],
  ]);
  const res = await callTool("/api/violations?company=Acme&source=osha&limit=100", { DOL_API_KEY: KEY });
  assert.equal(res.status, 200);
  const lookups = calls.filter((c) => c.url.includes("/violation/json"));
  assert.ok(lookups.length > 1 && lookups.length <= 4, `chunks: ${lookups.length}`);
  for (const c of calls) assert.ok(c.url.length <= 1800, `URL of ${c.url.length} chars`);
  assert.ok(calls.length <= 6);
  const b = await res.json();
  assert.ok(b.results.every((r) => r.penalty === 0 || r.penalty === null), "penalty is 0 when looked up, null when beyond the chunk cap");
  // chunkIds on its own
  const chunks = chunkIds(ids, KEY);
  assert.deepEqual(chunks.flat(), ids);
  for (const c of chunks) assert.ok(dolUrl("violation", KEY, { limit: 200, filter_object: JSON.stringify({ field: "activity_nr", operator: "in", value: c }) }).length <= 1800);
});

test("minPenalty filters rows; since and limit are applied", async (t) => {
  mockFetch(t, [
    ["/OSHA/inspection/json", { data: [inspection("1"), inspection("2")] }],
    ["/OSHA/violation/json", { data: [{ activity_nr: "1", current_penalty: "100" }, { activity_nr: "2", current_penalty: "20000" }] }],
    ...EPA,
  ]);
  const b = await (await callTool("/api/violations?company=Acme&minPenalty=10000&since=2020-01-01", { DOL_API_KEY: KEY })).json();
  assert.deepEqual(b.results.map((r) => r.penalty).sort((a, c) => c - a), [50000, 20000]);
  assert.deepEqual(b.query.sources, ["osha", "epa"]);
});

test("bad input is 400 and nothing is fetched", async (t) => {
  const calls = mockFetch(t, []);
  for (const q of ["", "company=Acme&state=Texas", "company=Acme&since=soon", "company=Acme&minPenalty=lots", "company=Acme&source=msha"]) assert.equal((await callTool(`/api/violations?${q}`)).status, 400, q);
  assert.equal(calls.length, 0);
});

test("EPA says the search is too broad: 400, not charged", async (t) => {
  mockFetch(t, [[echo("echo_rest_services.get_facilities"), { Results: { Error: { ErrorMessage: "Rows Returned would be 312702. Queryset Limit would be exceeded - please make search parameters more selective." } } }]]);
  const res = await callTool("/api/violations?company=a&source=epa");
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /too broad.*not charged/);
});

test("upstream failures are 5xx", async (t) => {
  mockFetch(t, [["/OSHA/inspection/json", status(500)], ...EPA]);
  const down = await callTool("/api/violations?company=Acme", { DOL_API_KEY: KEY });
  assert.equal(down.status, 503);
  assert.match((await down.json()).error, /DOL OSHA API.*not charged/);
  mockFetch(t, [["/OSHA/inspection/json", status(403)]]);
  assert.equal((await callTool("/api/violations?company=Acme&source=osha", { DOL_API_KEY: KEY })).status, 502);
  mockFetch(t, [[echo("echo_rest_services.get_facilities"), status(503)]]);
  assert.equal((await callTool("/api/violations?company=Acme&source=epa")).status, 503);
  const calls = mockFetch(t, []);
  const off = await callTool("/api/violations?company=Acme&source=osha");
  assert.equal(off.status, 503);
  assert.equal(calls.length, 0);
});
