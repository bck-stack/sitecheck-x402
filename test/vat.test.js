import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, mockFetch, status } from "./biz-helpers.js";
import { VAT_COUNTRIES, checkVatLocal, parseVat } from "../lib/vat.js";

const VIES = "check-vat-number";
const viesOk = (over = {}) => ({ countryCode: "IT", vatNumber: "00743110157", requestDate: "2026-10-07T08:52:31.520Z", valid: true, name: "MOTOROLA SOLUTIONS ITALIA SRL", address: "LARGO FRANCESCO RICHINI 6 \n20122 MILANO MI\n", ...over });

test("all 27 EU states plus Northern Ireland are supported", () => {
  const eu = "AT BE BG CY CZ DE DK EE EL ES FI FR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK".split(" ");
  assert.equal(eu.length, 27);
  for (const c of [...eu, "XI"]) assert.ok(VAT_COUNTRIES.includes(c), c);
});

test("checksums accept real numbers and reject a changed digit", () => {
  const real = ["DE811907980", "ESA28015865", "IT00743110157", "FR40303265045", "BE0417497106", "NL004495445B01", "ATU33864707", "PL5260001246", "DK13585628", "FI01120389", "SE556703748501", "PT501964843", "IE6388047V", "LU15027442", "SK2020317068", "HU12892312", "SI50223054", "EL094259216", "RO11201891"];
  for (const n of real) {
    const { country, number } = parseVat(n);
    assert.equal(checkVatLocal(country, number).ok, true, n);
    if (["NL", "IE"].includes(country)) continue; // format only: VIES decides
    const bad = number.slice(0, 3) + String((+number[3] + 1) % 10) + number.slice(4);
    assert.equal(checkVatLocal(country, bad).ok, false, `${n} with a changed digit`);
  }
});

test("a wrong checksum is rejected with 400 and VIES is never called", async (t) => {
  const calls = mockFetch(t, [[VIES, viesOk()]]);
  const res = await callTool("/api/vat?number=DE811907981");
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.valid, false);
  assert.match(body.error, /check digit/);
  assert.match(body.error, /not charged/);
  assert.equal(calls.length, 0);
  for (const bad of ["", "number=XX123", "number=DE12", "number=ABC"]) {
    const r = await callTool(`/api/vat?${bad}`);
    assert.equal(r.status, 400, bad);
  }
  assert.equal(calls.length, 0);
});

test("valid number: VIES is asked with the country code split off, address tidied", async (t) => {
  const calls = mockFetch(t, [[VIES, viesOk()]]);
  const res = await callTool("/api/vat?number=it%2000743110157");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([body.valid, body.viesStatus, body.countryCode, body.vatNumber], [true, "OK", "IT", "00743110157"]);
  assert.equal(body.name, "MOTOROLA SOLUTIONS ITALIA SRL");
  assert.equal(body.address, "LARGO FRANCESCO RICHINI 6, 20122 MILANO MI");
  assert.equal(body.requestDate, "2026-10-07T08:52:31.520Z");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { countryCode: "IT", vatNumber: "00743110157" });
  assert.match(calls[0].headers["user-agent"], /^SiteCheck\/1\.x/);
  assert.ok(calls[0].signal, "has a timeout");
});

test("member states that hide the trader get null name and address, not '---'", async (t) => {
  mockFetch(t, [[VIES, viesOk({ countryCode: "DE", vatNumber: "811907980", name: "---", address: "---" })]]);
  const body = await (await callTool("/api/vat?number=DE811907980")).json();
  assert.equal(body.valid, true);
  assert.equal(body.name, null);
  assert.equal(body.address, null);
  assert.match(body.note, /does not disclose/);
});

test("VIES says not valid: 200 with valid false (an answer, not an error)", async (t) => {
  mockFetch(t, [[VIES, viesOk({ valid: false, name: "", address: "" })]]);
  const res = await callTool("/api/vat?number=IT00743110157");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).valid, false);
});

test("a member state that is down is 503 with its viesStatus, never a 200", async (t) => {
  for (const code of ["MS_UNAVAILABLE", "MS_MAX_CONCURRENT_REQ", "TIMEOUT", "SERVICE_UNAVAILABLE"]) {
    mockFetch(t, [[VIES, { actionSucceed: false, errorWrappers: [{ error: code }] }]]);
    const res = await callTool("/api/vat?number=IT00743110157");
    assert.equal(res.status, 503, code);
    const body = await res.json();
    assert.equal(body.viesStatus, code);
    assert.match(body.error, /not charged/);
    assert.match(body.error, new RegExp(code));
  }
});

test("VIES HTTP errors, timeouts and network failures are 5xx", async (t) => {
  mockFetch(t, [[VIES, status(500)]]);
  assert.equal((await callTool("/api/vat?number=IT00743110157")).status, 503);
  mockFetch(t, [[VIES, () => { const e = new Error("t"); e.name = "TimeoutError"; return e; }]]);
  const res = await callTool("/api/vat?number=IT00743110157");
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /timed out.*not charged/);
  mockFetch(t, [[VIES, () => new Error("connection reset")]]);
  assert.equal((await callTool("/api/vat?number=IT00743110157")).status, 502);
  mockFetch(t, [[VIES, status(200, { unexpected: true })]]);
  assert.equal((await callTool("/api/vat?number=IT00743110157")).status, 503);
});

test("Northern Ireland (XI) and Greece (GR prefix) go to VIES", async (t) => {
  const calls = mockFetch(t, [[VIES, viesOk({ countryCode: "XI", vatNumber: "123456789", valid: false })]]);
  assert.equal((await callTool("/api/vat?number=XI123456789")).status, 200);
  assert.equal(calls[0].body.countryCode, "XI");
  mockFetch(t, [[VIES, (c) => viesOk({ countryCode: c.body.countryCode, vatNumber: c.body.vatNumber })]]);
  const body = await (await callTool("/api/vat?number=GR094259216")).json();
  assert.equal(body.countryCode, "EL");
});
