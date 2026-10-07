// GET /api/vat: EU VAT number check. Format and checksum are tested locally first (no network call when
// they fail), then the official VIES REST API answers. VIES errors map to 503 so the buyer is not charged.
import { fetchJson, badInput, ToolError, upstreamDown } from "./upstream.js";

const VIES = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";

const digits = (s) => [...s].map(Number);
const sum = (arr, w) => arr.reduce((a, d, i) => a + d * w[i], 0);
const luhn = (s) => digits(s).reverse().reduce((a, d, i) => { if (i % 2) { d *= 2; if (d > 9) d -= 9; } return a + d; }, 0) % 10 === 0;
// ISO 7064 MOD 11,10 over all digits (DE, HR): the last digit is the check digit.
const mod1110 = (s) => {
  let p = 10;
  for (const d of digits(s).slice(0, -1)) { let t = (d + p) % 10; if (t === 0) t = 10; p = (t * 2) % 11; }
  return (11 - p) % 10 === +s.at(-1) || (p === 1 && +s.at(-1) === 0);
};
const ES_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

// Per country: regex over the number without the country prefix, and an optional checksum (null = format only,
// VIES decides). Checksums are only implemented where the algorithm is unambiguous.
export const VAT_RULES = {
  AT: { re: /^U\d{8}$/, sum: (n) => { const d = digits(n.slice(1)); const s = d.slice(0, 7).reduce((a, x, i) => a + (i % 2 ? [0, 2, 4, 6, 8, 1, 3, 5, 7, 9][x] : x), 0); return (10 - ((s + 4) % 10)) % 10 === d[7]; } },
  BE: { re: /^[01]\d{9}$/, sum: (n) => 97 - (+n.slice(0, 8) % 97) === +n.slice(8) },
  BG: { re: /^\d{9,10}$/ },
  CY: { re: /^\d{8}[A-Z]$/ },
  CZ: { re: /^\d{8,10}$/ },
  DE: { re: /^[1-9]\d{8}$/, sum: mod1110 },
  DK: { re: /^[1-9]\d{7}$/, sum: (n) => sum(digits(n), [2, 7, 6, 5, 4, 3, 2, 1]) % 11 === 0 },
  EE: { re: /^10\d{7}$/, sum: (n) => (10 - (sum(digits(n).slice(0, 8), [3, 7, 1, 3, 7, 1, 3, 7]) % 10)) % 10 === +n[8] },
  EL: { re: /^\d{9}$/, sum: (n) => ((sum(digits(n).slice(0, 8), [256, 128, 64, 32, 16, 8, 4, 2]) % 11) % 10) === +n[8] },
  ES: { re: /^[A-Z0-9]\d{7}[A-Z0-9]$/, sum: (n) => {
    if (/^[A-HJNP-SUVW]\d{7}[0-9A-J]$/.test(n)) { // legal entities
      const d = digits(n.slice(1, 8)); let s = 0;
      d.forEach((x, i) => { if (i % 2 === 0) { x *= 2; if (x > 9) x -= 9; } s += x; });
      const c = (10 - (s % 10)) % 10;
      return n[8] === String(c) || n[8] === "JABCDEFGHI"[c];
    }
    if (/^\d{8}[A-Z]$/.test(n)) return ES_LETTERS[+n.slice(0, 8) % 23] === n[8]; // DNI
    if (/^[XYZ]\d{7}[A-Z]$/.test(n)) return ES_LETTERS[+(("XYZ".indexOf(n[0])) + n.slice(1, 8)) % 23] === n[8]; // NIE
    if (/^[KLM]\d{7}[A-Z]$/.test(n)) return true; // special natural persons: leave to VIES
    return false;
  } },
  FI: { re: /^\d{8}$/, sum: (n) => { const r = sum(digits(n).slice(0, 7), [7, 9, 10, 5, 8, 4, 2]) % 11; return r !== 1 && (r === 0 ? 0 : 11 - r) === +n[7]; } },
  FR: { re: /^[0-9A-HJ-NP-Z]{2}\d{9}$/, sum: (n) => !/^\d{2}/.test(n) ? true : (12 + 3 * (+n.slice(2) % 97)) % 97 === +n.slice(0, 2) },
  HR: { re: /^\d{11}$/, sum: mod1110 },
  HU: { re: /^\d{8}$/, sum: (n) => sum(digits(n), [9, 7, 3, 1, 9, 7, 3, 1]) % 10 === 0 },
  IE: { re: /^(\d[A-Z+*]\d{5}[A-W]|\d{7}[A-W][A-I]?)$/ },
  IT: { re: /^\d{11}$/, sum: (n) => +n.slice(0, 7) > 0 && +n.slice(7, 10) <= 201 && luhn(n) },
  LT: { re: /^(\d{9}|\d{12})$/ },
  LU: { re: /^\d{8}$/, sum: (n) => +n.slice(0, 6) % 89 === +n.slice(6) },
  LV: { re: /^\d{11}$/ },
  MT: { re: /^[1-9]\d{7}$/, sum: (n) => 37 - (sum(digits(n).slice(0, 6), [3, 4, 6, 7, 8, 9]) % 37) === +n.slice(6) },
  NL: { re: /^\d{9}B\d{2}$/ }, // numbers issued since 2020 no longer follow the old mod-11 rule: VIES decides
  PL: { re: /^\d{10}$/, sum: (n) => { const r = sum(digits(n).slice(0, 9), [6, 5, 7, 2, 3, 4, 5, 6, 7]) % 11; return r !== 10 && r === +n[9]; } },
  PT: { re: /^\d{9}$/, sum: (n) => { const r = 11 - (sum(digits(n).slice(0, 8), [9, 8, 7, 6, 5, 4, 3, 2]) % 11); return (r >= 10 ? 0 : r) === +n[8]; } },
  RO: { re: /^[1-9]\d{1,9}$/, sum: (n) => { const p = n.padStart(10, "0"); const r = (sum(digits(p).slice(0, 9), [7, 5, 3, 2, 1, 7, 5, 3, 2]) * 10) % 11; return (r === 10 ? 0 : r) === +p[9]; } },
  SE: { re: /^\d{10}01$/, sum: (n) => luhn(n.slice(0, 10)) },
  SI: { re: /^[1-9]\d{7}$/, sum: (n) => { const r = 11 - (sum(digits(n).slice(0, 7), [8, 7, 6, 5, 4, 3, 2]) % 11); const c = r === 10 ? 0 : r; return r !== 11 && c === +n[7]; } },
  SK: { re: /^[1-9]\d[2-47-9]\d{7}$/, sum: (n) => +n % 11 === 0 },
  // Northern Ireland: the UK format (9 digits or 12 for branches, GD/HA for government and health authorities).
  XI: { re: /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/ },
};
const ALIAS = { GR: "EL" }; // Greece is EL in VAT numbers
export const VAT_COUNTRIES = Object.keys(VAT_RULES);

// Splits "de 811.907.980" into { country, number }. Throws a 400 for anything that is not a plausible number.
export function parseVat(raw, countryParam) {
  if (!raw || typeof raw !== "string") throw badInput("number is required, e.g. number=DE811907980");
  const s = raw.toUpperCase().replace(/[\s.\-_/]/g, "");
  const code = (c) => ALIAS[c] || c;
  let country, number;
  if (countryParam) {
    country = code(String(countryParam).toUpperCase().trim());
    number = /^(GR|EL)/.test(s) && country === "EL" ? s.slice(2) : s.startsWith(country) ? s.slice(2) : s;
  } else { country = code(s.slice(0, 2)); number = s.slice(2); }
  if (!VAT_RULES[country]) throw badInput(`unknown or unsupported country prefix. Use the two-letter VAT prefix (${VAT_COUNTRIES.join(", ")}), e.g. DE811907980`);
  return { country, number };
}

// Local check: { ok, reason }. No network.
export function checkVatLocal(country, number) {
  const rule = VAT_RULES[country];
  if (!rule.re.test(number)) return { ok: false, reason: `not a valid ${country} VAT number format` };
  if (rule.sum && !rule.sum(number)) return { ok: false, reason: `${country} check digit does not match` };
  return { ok: true, checksum: rule.sum ? "verified" : "not available for this country (format only)" };
}

const clean = (v) => (typeof v === "string" && v.trim() && !/^-+$/.test(v.trim()) ? v.trim() : null);
// VIES error codes that mean "try again later" (503) versus "your input is wrong" (400).
const RETRYABLE = new Set(["MS_UNAVAILABLE", "MS_MAX_CONCURRENT_REQ", "GLOBAL_MAX_CONCURRENT_REQ", "SERVICE_UNAVAILABLE", "TIMEOUT", "MS_TIMEOUT", "VAT_BLOCKED", "IP_BLOCKED"]);
const EXPLAIN = {
  MS_UNAVAILABLE: "the member state's VAT database is down",
  MS_MAX_CONCURRENT_REQ: "the member state's VAT database is overloaded",
  GLOBAL_MAX_CONCURRENT_REQ: "VIES is overloaded",
  SERVICE_UNAVAILABLE: "VIES is down", TIMEOUT: "VIES timed out", MS_TIMEOUT: "the member state's VAT database timed out",
};

export async function vat(q) {
  const { country, number } = parseVat(q.number ?? q.vat, q.country);
  const local = checkVatLocal(country, number);
  const base = { input: String(q.number ?? q.vat), countryCode: country, vatNumber: number, formatted: `${country}${number}` };
  if (!local.ok) throw Object.assign(badInput(`${base.formatted}: ${local.reason}. No lookup was made and you were not charged.`), { body: { valid: false, ...base } });

  const res = await fetchJson(VIES, {
    name: "VIES", init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ countryCode: country, vatNumber: number }) },
    onStatus: async (r) => {
      let body = null;
      try { body = await r.json(); } catch { /* ignore */ }
      if (r.status === 400 || r.status === 422) throw badInput(`VIES rejected the number: ${clean(body?.errorWrappers?.[0]?.error) || "invalid input"}. You were not charged.`);
      return undefined;
    },
  });
  const err = res?.errorWrappers?.[0]?.error || (res?.actionSucceed === false ? "UNKNOWN" : null);
  if (err) {
    if (err === "INVALID_INPUT") throw badInput("VIES rejected the number as invalid input. You were not charged.");
    const e = new ToolError(RETRYABLE.has(err) || err === "UNKNOWN" ? 503 : 502,
      `VIES could not answer (viesStatus ${err}: ${EXPLAIN[err] || "upstream error"}). The answer is unknown, not "invalid", and you were not charged. Please retry later.`);
    e.body = { viesStatus: err, ...base };
    throw e;
  }
  if (typeof res?.valid !== "boolean") throw upstreamDown("VIES", "returned an unexpected answer");
  return {
    ...base, valid: res.valid, viesStatus: "OK",
    name: clean(res.name), address: clean(res.address)?.replace(/\s*\n+\s*/g, ", ").replace(/,\s*$/, "") ?? null,
    requestDate: res.requestDate ?? null,
    checks: { format: "ok", checksum: local.checksum },
    note: res.valid && !clean(res.name) ? "Valid. This member state does not disclose the trader's name and address through VIES." : undefined,
    source: "European Commission VIES (https://ec.europa.eu/taxation_customs/vies/)",
  };
}
