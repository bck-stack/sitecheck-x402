import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, mockFetch } from "./biz-helpers.js";
import { validateIban, IBAN_REGISTRY, NATIONAL_CHECKS } from "../lib/iban.js";

// Examples from the SWIFT IBAN registry.
const EXAMPLES = "AD1200012030200359100100 AE070331234567890123456 AL47212110090000000235698741 AT611904300234573201 AZ21NABZ00000000137010001944 BA391290079401028494 BE68539007547034 BG80BNBG96611020345678 BH67BMAG00001299123456 BR1800360305000010009795493C1 BY13NBRB3600900000002Z00AB00 CH9300762011623852957 CR05015202001026284066 CY17002001280000001200527600 CZ6508000000192000145399 DE89370400440532013000 DK5000400440116243 DO28BAGR00000001212453611324 EE382200221020145685 EG380019000500000000263180002 ES9121000418450200051332 FI2112345600000785 FO6264600001631634 FR1420041010050500013M02606 GB29NWBK60161331926819 GE29NB0000000101904917 GI75NWBK000000007099453 GL8964710001000206 GR1601101250000000012300695 GT82TRAJ01020000001210029690 HR1210010051863000160 HU42117730161111101800000000 IE29AIBK93115212345678 IL620108000000099999999 IS140159260076545510730339 IT60X0542811101000000123456 JO94CBJO0010000000000131000302 KW81CBKU0000000000001234560101 KZ86125KZT5004100100 LB62099900000001001901229114 LC55HEMM000100010012001200023015 LI21088100002324013AA LT121000011101001000 LU280019400644750000 LV80BANK0000435195001 LY83002048000020100120361 MC5811222000010123456789030 MD24AG000225100013104168 ME25505000012345678951 MK07250120000058984 MR1300020001010000123456753 MT84MALT011000012345MTLCAST001S MU17BOMM0101101030300200000MUR NL91ABNA0417164300 NO9386011117947 PK36SCBL0000001123456702 PL61109010140000071219812874 PS92PALS000000000400123456702 PT50000201231234567890154 QA58DOHB00001234567890ABCDEFG RO49AAAA1B31007593840000 RS35260005601001611379 SA0380000000608010167519 SC18SSCB11010000000000001497USD SE4550000000058398257466 SI56263300012039086 SK3112000000198742637541 SM86U0322509800000000270100 ST68000100010051845310112 SV62CENR00000000000000700025 TL380080012345678910157 TN5910006035183598478831 TR330006100519786457841326 UA213223130000026007233566001 VA59001123000012345678 VG96VPVG0000012345678901 XK051212012345678906 IQ98NBIQ850123456789012 BI4210000100010000332045181 DJ2100010000000154000100186 NI45BAPR00000013000003558124 MN121234123456789123 OM810180000001299123456 FK88SC123456789012 YE15CBYE0001018861234567891234 SD2129010501234001 SO211000001001000100141 RU0304452522540817810538091310419 HN88CABF00000000000250005469".split(" ");

// Rebuilds the two ISO 13616 check digits, so a test can break only the national digits.
const withCheck = (cc, bban) => {
  const n = (s) => [...s].map((c) => (c >= "A" ? c.charCodeAt(0) - 55 : c)).join("");
  let r = 0; for (const d of n(`${bban}${cc}00`)) r = (r * 10 + +d) % 97;
  return `${cc}${String(98 - r).padStart(2, "0")}${bban}`;
};

test("every SWIFT registry example is valid and the registry matches its lengths", () => {
  for (const e of EXAMPLES) {
    const r = validateIban(e);
    assert.equal(r.valid, true, `${e}: ${r.errors}`);
    assert.equal(e.length, IBAN_REGISTRY[e.slice(0, 2)][0], e);
  }
  assert.ok(Object.keys(IBAN_REGISTRY).length >= 85);
});

test("spaces and lowercase are accepted; electronic and print formats are returned", async () => {
  const res = await callTool("/api/iban?iban=de89%203704%200044%200532%200130%2000");
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.valid, true);
  assert.equal(b.ibanElectronic, "DE89370400440532013000");
  assert.equal(b.ibanPrint, "DE89 3704 0044 0532 0130 00");
  assert.deepEqual([b.bankCode, b.branchCode, b.account], ["37040044", null, "0532013000"]);
  assert.equal(b.bankLookup, false);
  const lower = await (await callTool("/api/iban?iban=gb29nwbk60161331926819")).json();
  assert.deepEqual([lower.valid, lower.bankCode, lower.branchCode, lower.account], [true, "NWBK", "601613", "31926819"]);
  const es = await (await callTool("/api/iban?iban=ES9121000418450200051332")).json();
  assert.deepEqual([es.bankCode, es.branchCode], ["2100", "0418"]);
  const fr = await (await callTool("/api/iban?iban=FR1420041010050500013M02606")).json();
  assert.deepEqual([fr.bankCode, fr.branchCode], ["20041", "01005"]);
  const it = await (await callTool("/api/iban?iban=IT60X0542811101000000123456")).json();
  assert.deepEqual([it.bankCode, it.branchCode, it.account], ["05428", "11101", "000000123456"]);
});

test("no network is ever used", async (t) => {
  const calls = mockFetch(t, []);
  await callTool("/api/iban?iban=DE89370400440532013000");
  await callTool("/api/iban?ibans=DE89370400440532013000,XX00");
  assert.equal(calls.length, 0);
});

test("structure, length, country and checksum failures say what is wrong", () => {
  assert.match(validateIban("DE89370400440532013001").errors[0], /checksum/);
  assert.match(validateIban("DE8937040044053201300").errors[0], /22 characters/);
  assert.match(validateIban("XX89370400440532013000").errors[0], /does not use IBAN/);
  assert.match(validateIban("DE89A70400440532013000").errors[0], /structure/);
  assert.match(validateIban("89DE").errors[0], /country code/);
  assert.match(validateIban("DE89-3704-0044!").errors[0], /letters and digits/);
  assert.equal(validateIban("").valid, false);
});

test("national check digits: FR, ES, IT, BE, NL, NO, FI (and PL, PT) catch a typo the ISO checksum was fixed for", () => {
  const cases = {
    FR: ["FR1420041010050500013M02606", (b) => b.slice(0, 21) + "00"],
    ES: ["ES9121000418450200051332", (b) => b.slice(0, 8) + "00" + b.slice(10)],
    IT: ["IT60X0542811101000000123456", (b) => "A" + b.slice(1)],
    BE: ["BE68539007547034", (b) => b.slice(0, 10) + "00"],
    NL: ["NL91ABNA0417164300", (b) => b.slice(0, 4) + "0417164301"],
    NO: ["NO9386011117947", (b) => b.slice(0, 10) + "0"],
    FI: ["FI2112345600000785", (b) => b.slice(0, 13) + "0"],
    PL: ["PL61109010140000071219812874", (b) => b.slice(0, 7) + "0" + b.slice(8)],
    PT: ["PT50000201231234567890154", (b) => b.slice(0, 19) + "00"],
  };
  for (const [cc, [good, damage]] of Object.entries(cases)) {
    assert.ok(NATIONAL_CHECKS[cc], cc);
    const ok = validateIban(good);
    assert.equal(ok.nationalCheck.status, "ok", cc);
    const bad = validateIban(withCheck(cc, damage(good.slice(4))));
    assert.equal(bad.valid, false, `${cc} with wrong national digits`);
    assert.match(bad.errors[0], /national check digits/, cc);
  }
  // DE has no published national algorithm: reported honestly, not faked.
  assert.equal(validateIban("DE89370400440532013000").nationalCheck.status, "not-available");
});

test("batch: up to 50, per-IBAN results, and bad requests are 400", async () => {
  const res = await callTool("/api/iban?ibans=DE89370400440532013000,%20nl91abna0417164300,FR00");
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.deepEqual([b.count, b.valid, b.invalid], [3, 2, 1]);
  assert.deepEqual(b.results.map((r) => r.valid), [true, true, false]);
  const fifty = Array(50).fill("DE89370400440532013000").join(",");
  assert.equal((await callTool(`/api/iban?ibans=${fifty}`)).status, 200);
  const r51 = await callTool(`/api/iban?ibans=${fifty},DE89370400440532013000`);
  assert.equal(r51.status, 400);
  assert.match((await r51.json()).error, /at most 50/);
  assert.equal((await callTool("/api/iban")).status, 400);
  assert.equal((await callTool("/api/iban?ibans=,")).status, 400);
});
