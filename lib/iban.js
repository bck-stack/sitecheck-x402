// GET /api/iban: IBAN validation with no network. ISO 13616 structure and length per country (SWIFT IBAN
// registry), mod-97 checksum, national check digits where a public algorithm exists, and the split into
// bank / branch / account. No bank-name or BIC lookup: that needs a dataset we do not bundle.
import { badInput } from "./upstream.js";

// code: [total length, BBAN structure (SWIFT notation: n digits, a letters, c alphanumeric), bank length, branch length, (bank offset), country]
// Derived from the SWIFT IBAN registry (release 101). Branch directly follows the bank code, except where an offset is given.
export const IBAN_REGISTRY = {
  AD: [24, "4!n4!n12!c", 4, 4, "Andorra"],
  AE: [23, "3!n16!n", 3, 0, "United Arab Emirates"],
  AL: [28, "8!n16!c", 3, 4, "Albania"],
  AT: [20, "5!n11!n", 5, 0, "Austria"],
  AZ: [28, "4!a20!c", 4, 0, "Azerbaijan"],
  BA: [20, "3!n3!n8!n2!n", 3, 3, "Bosnia and Herzegovina"],
  BE: [16, "3!n7!n2!n", 3, 0, "Belgium"],
  BG: [22, "4!a4!n2!n8!c", 4, 4, "Bulgaria"],
  BH: [22, "4!a14!c", 4, 0, "Bahrain"],
  BI: [27, "5!n5!n11!n2!n", 5, 5, "Burundi"],
  BR: [29, "8!n5!n10!n1!a1!c", 8, 5, "Brazil"],
  BY: [28, "4!c4!n16!c", 4, 4, "Belarus"],
  CH: [21, "5!n12!c", 5, 0, "Switzerland"],
  CR: [22, "4!n14!n", 4, 0, "Costa Rica"],
  CY: [28, "3!n5!n16!c", 3, 5, "Cyprus"],
  CZ: [24, "4!n16!n", 4, 0, "Czechia"],
  DE: [22, "8!n10!n", 8, 0, "Germany"],
  DJ: [27, "5!n5!n11!n2!n", 5, 5, "Djibouti"],
  DK: [18, "4!n9!n1!n", 4, 0, "Denmark"],
  DO: [28, "4!c20!n", 4, 0, "Dominican Republic"],
  EE: [20, "2!n14!n", 2, 0, "Estonia"],
  EG: [29, "4!n4!n17!n", 4, 4, "Egypt"],
  ES: [24, "4!n4!n1!n1!n10!n", 4, 4, "Spain"],
  FI: [18, "3!n11!n", 3, 0, "Finland"],
  FK: [18, "2!a12!n", 2, 0, "Falkland Islands (Malvinas)"],
  FO: [18, "4!n9!n1!n", 4, 0, "Faroe Islands"],
  FR: [27, "5!n5!n11!c2!n", 5, 5, "France"],
  GB: [22, "4!a6!n8!n", 4, 6, "United Kingdom"],
  GE: [22, "2!a16!n", 2, 0, "Georgia"],
  GI: [23, "4!a15!c", 4, 0, "Gibraltar"],
  GL: [18, "4!n9!n1!n", 4, 0, "Greenland"],
  GR: [27, "3!n4!n16!c", 3, 4, "Greece"],
  GT: [28, "4!c20!c", 4, 0, "Guatemala"],
  HN: [28, "4!a20!n", 4, 0, "Honduras"],
  HR: [21, "7!n10!n", 7, 0, "Croatia"],
  HU: [28, "3!n4!n1!n15!n1!n", 3, 4, "Hungary"],
  IE: [22, "4!a6!n8!n", 4, 6, "Ireland"],
  IL: [23, "3!n3!n13!n", 3, 3, "Israel"],
  IQ: [23, "4!a3!n12!n", 4, 3, "Iraq"],
  IS: [26, "4!n2!n6!n10!n", 4, 2, "Iceland"],
  IT: [27, "1!a5!n5!n12!c", 5, 5, 1, "Italy"],
  JO: [30, "4!a4!n18!c", 4, 4, "Jordan"],
  KW: [30, "4!a22!c", 4, 0, "Kuwait"],
  KZ: [20, "3!n13!c", 3, 0, "Kazakhstan"],
  LB: [28, "4!n20!c", 4, 0, "Lebanon"],
  LC: [32, "4!a24!c", 4, 0, "Saint Lucia"],
  LI: [21, "5!n12!c", 5, 0, "Liechtenstein"],
  LT: [20, "5!n11!n", 5, 0, "Lithuania"],
  LU: [20, "3!n13!c", 3, 0, "Luxembourg"],
  LV: [21, "4!a13!c", 4, 0, "Latvia"],
  LY: [25, "3!n3!n15!n", 3, 3, "Libya"],
  MC: [27, "5!n5!n11!c2!n", 5, 5, "Monaco"],
  MD: [24, "2!c18!c", 2, 0, "Moldova"],
  ME: [22, "3!n13!n2!n", 3, 0, "Montenegro"],
  MK: [19, "3!n10!c2!n", 3, 0, "North Macedonia"],
  MN: [20, "4!n12!n", 4, 0, "Mongolia"],
  MR: [27, "5!n5!n11!n2!n", 5, 5, "Mauritania"],
  MT: [31, "4!a5!n18!c", 4, 5, "Malta"],
  MU: [30, "4!a2!n2!n12!n3!n3!a", 6, 2, "Mauritius"],
  NI: [28, "4!a20!n", 4, 0, "Nicaragua"],
  NL: [18, "4!a10!n", 4, 0, "Netherlands"],
  NO: [15, "4!n6!n1!n", 4, 0, "Norway"],
  OM: [23, "3!n16!c", 3, 0, "Oman"],
  PK: [24, "4!a16!c", 4, 0, "Pakistan"],
  PL: [28, "8!n16!n", 3, 4, "Poland"],
  PS: [29, "4!a21!c", 4, 0, "Palestine"],
  PT: [25, "4!n4!n11!n2!n", 4, 4, "Portugal"],
  QA: [29, "4!a21!c", 4, 0, "Qatar"],
  RO: [24, "4!a16!c", 4, 0, "Romania"],
  RS: [22, "3!n13!n2!n", 3, 0, "Serbia"],
  RU: [33, "9!n5!n15!c", 9, 5, "Russian Federation"],
  SA: [24, "2!n18!c", 2, 0, "Saudi Arabia"],
  SC: [31, "4!a2!n2!n16!n3!a", 6, 2, "Seychelles"],
  SD: [18, "2!n12!n", 2, 0, "Sudan"],
  SE: [24, "3!n16!n1!n", 3, 0, "Sweden"],
  SI: [19, "5!n8!n2!n", 5, 0, "Slovenia"],
  SK: [24, "4!n6!n10!n", 4, 0, "Slovakia"],
  SM: [27, "1!a5!n5!n12!c", 5, 5, 1, "San Marino"],
  SO: [23, "4!n3!n12!n", 4, 3, "Somalia"],
  ST: [25, "4!n4!n11!n2!n", 4, 4, "Sao Tome and Principe"],
  SV: [28, "4!a20!n", 4, 0, "El Salvador"],
  TL: [23, "3!n14!n2!n", 3, 0, "Timor-Leste"],
  TN: [24, "2!n3!n13!n2!n", 2, 3, "Tunisia"],
  TR: [26, "5!n1!n16!c", 5, 0, "Turkiye"],
  UA: [29, "6!n19!c", 6, 0, "Ukraine"],
  VA: [22, "3!n15!n", 3, 0, "Holy See"],
  VG: [24, "4!a16!n", 4, 0, "Virgin Islands (British)"],
  XK: [20, "4!n10!n2!n", 2, 2, "Kosovo"],
  YE: [30, "4!a4!n18!c", 4, 4, "Yemen"],
};
// Territories that use another country's IBAN structure and the code of that country.
const ALIAS = { GF: "FR", GP: "FR", MQ: "FR", RE: "FR", PF: "FR", TF: "FR", YT: "FR", NC: "FR", BL: "FR", MF: "FR", PM: "FR", WF: "FR", IM: "GB", JE: "GB", GG: "GB", AX: "FI" };
export const IBAN_COUNTRIES = Object.keys(IBAN_REGISTRY).length;
const MAX_BATCH = 50;

const num = (s) => [...s].map((c) => (c >= "A" ? c.charCodeAt(0) - 55 : +c)).join("");
// mod 97 of a digit string, in chunks (no BigInt needed)
const mod97 = (digits) => { let r = 0; for (let i = 0; i < digits.length; i += 7) r = +(`${r}${digits.slice(i, i + 7)}`) % 97; return r; };
const ds = (s) => [...s].map(Number);
const wsum = (s, w) => ds(s).reduce((a, d, i) => a + d * w[i], 0);
const luhn = (s) => ds(s).reverse().reduce((a, d, i) => { if (i % 2) { d *= 2; if (d > 9) d -= 9; } return a + d; }, 0) % 10 === 0;
const regexOf = (fmt) => new RegExp(`^${[...fmt.matchAll(/(\d+)!([nac])/g)].map(([, n, t]) => `${{ n: "[0-9]", a: "[A-Z]", c: "[A-Z0-9]" }[t]}{${n}}`).join("")}$`);

const ES_W = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6];
const esDigit = (s, w) => { const r = 11 - (wsum(s, w) % 11); return r === 10 ? 1 : r === 11 ? 0 : r; };
const IT_ODD = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];
const itCin = (s) => {
  let t = 0;
  [...s].forEach((c, i) => { const v = c >= "A" ? c.charCodeAt(0) - 65 : +c; t += i % 2 === 0 ? IT_ODD[v] : v; });
  return String.fromCharCode(65 + (t % 26));
};
const mod97Whole = (b) => mod97(num(b)) === 1; // BBAN as a number, check digits last: remainder 1

// National check digits. Each takes (bban, parts) and returns true/false. Only published algorithms; the rest are
// reported as "not available".
export const NATIONAL_CHECKS = {
  BE: (b) => { const r = +b.slice(0, 10) % 97; return (r === 0 ? 97 : r) === +b.slice(10); },
  FR: (b) => {
    const c = b.slice(10, 21).replace(/[A-Z]/g, (ch) => { const v = ch.charCodeAt(0) - 64; return String(v <= 9 ? v : v <= 18 ? v - 9 : v - 17); });
    return 97 - ((89 * +b.slice(0, 5) + 15 * +b.slice(5, 10) + 3 * +c) % 97) === +b.slice(21);
  },
  ES: (b) => esDigit(`00${b.slice(0, 8)}`, ES_W) === +b[8] && esDigit(b.slice(10), ES_W) === +b[9],
  IT: (b) => itCin(b.slice(1)) === b[0],
  NL: (b, p) => !/^(ABNA|INGB|RABO)$/.test(b.slice(0, 4)) || +p.account < 1e8 || wsum(b.slice(4), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]) % 11 === 0,
  NO: (b) => { if (b.slice(4, 6) === "00") return true; const r = wsum(b.slice(0, 10), [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]) % 11; return (r === 0 ? 0 : 11 - r) === +b[10]; },
  FI: (b) => luhn(b),
  PL: (b) => wsum(b.slice(0, 8), [3, 9, 7, 1, 3, 9, 7, 1]) % 10 === 0,
  PT: mod97Whole, RS: mod97Whole, ME: mod97Whole, MK: mod97Whole, XK: mod97Whole, SI: mod97Whole,
};
const NO_CHECK = "no public national check-digit algorithm is applied for this country";

// Cleans up what a caller typed: strips spaces and dashes, uppercases.
export const normalizeIban = (raw) => String(raw ?? "").replace(/[\s-]/g, "").toUpperCase();
export const printFormat = (s) => s.replace(/(.{4})(?=.)/g, "$1 ");

// Validates one IBAN. Always returns an object: { iban, valid, errors[], ... }. Never throws.
export function validateIban(raw) {
  const iban = normalizeIban(raw);
  const out = { input: String(raw ?? ""), valid: false, iban: iban || null, ibanPrint: iban ? printFormat(iban) : null, countryCode: iban.slice(0, 2) || null, errors: [] };
  const fail = (msg) => { out.errors.push(msg); return out; };
  if (!iban) return fail("empty IBAN");
  if (!/^[A-Z0-9]+$/.test(iban)) return fail("IBAN may contain only letters and digits (spaces and dashes are ignored)");
  if (!/^[A-Z]{2}\d{2}/.test(iban)) return fail("IBAN must start with a 2-letter country code and 2 check digits");
  const cc = iban.slice(0, 2);
  const reg = IBAN_REGISTRY[cc] || IBAN_REGISTRY[ALIAS[cc]];
  if (!reg) return fail(`country ${cc} does not use IBAN (not in the SWIFT IBAN registry)`);
  const [length, fmt, bankLen, branchLen, ...rest] = reg;
  const offset = typeof rest[0] === "number" ? rest[0] : 0;
  out.country = rest.at(-1);
  out.expectedLength = length;
  if (iban.length !== length) return fail(`${cc} IBANs have ${length} characters, this one has ${iban.length}`);
  const bban = iban.slice(4);
  if (!regexOf(fmt).test(bban)) return fail(`BBAN does not match the ${cc} structure (${fmt.replace(/(\d+)!n/g, "$1 digits ").replace(/(\d+)!a/g, "$1 letters ").replace(/(\d+)!c/g, "$1 alphanumeric ").trim()})`);
  if (mod97(num(bban + iban.slice(0, 4))) !== 1) return fail("checksum (mod 97) is wrong: the IBAN has a typo");
  const parts = { bankCode: bankLen ? bban.slice(offset, offset + bankLen) : null, branchCode: branchLen ? bban.slice(offset + bankLen, offset + bankLen + branchLen) : null };
  parts.account = bban.slice(offset + bankLen + branchLen);
  const check = NATIONAL_CHECKS[ALIAS[cc] || cc];
  let national;
  if (!check) national = { status: "not-available", note: NO_CHECK };
  else national = check(bban, parts) ? { status: "ok" } : { status: "failed", note: `the ${cc} national check digits do not match: a digit in the account or bank code is likely wrong` };
  out.nationalCheck = national;
  if (national.status === "failed") return fail(national.note);
  out.valid = true;
  out.ibanElectronic = iban;
  out.bban = bban;
  Object.assign(out, parts);
  out.checks = { structure: "ok", length: "ok", mod97: "ok", national: national.status };
  return out;
}

export async function iban(q) {
  if (q.ibans !== undefined && q.ibans !== "") {
    const list = String(q.ibans).split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length) throw badInput("ibans is empty. Send a comma-separated list, e.g. ibans=DE89370400440532013000,FR1420041010050500013M02606");
    if (list.length > MAX_BATCH) throw badInput(`at most ${MAX_BATCH} IBANs per call, got ${list.length}`);
    const results = list.map(validateIban);
    return { count: results.length, valid: results.filter((r) => r.valid).length, invalid: results.filter((r) => !r.valid).length, results, bankLookup: false };
  }
  if (!q.iban) throw badInput("iban is required, e.g. iban=DE89 3704 0044 0532 0130 00 (or ibans=a,b,c for up to 50)");
  if (String(q.iban).length > 80) throw badInput("iban is too long");
  return { ...validateIban(q.iban), bankLookup: false };
}
