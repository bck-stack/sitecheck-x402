// GET /api/fx: foreign exchange reference rates published by the European Central Bank (about 30 currencies,
// working days around 16:00 CET), through the open-source Frankfurter API. Latest or a past date (back to 1999),
// optional amount conversion, and a time series between two dates.
import { badInput, cached, clampInt, fetchJson, isoDate, ToolError } from "./upstream.js";

const BASE = "https://api.frankfurter.dev/v1";
const code = (v) => String(v ?? "").trim().toUpperCase();
const isCode = (c) => /^[A-Z]{3}$/.test(c);

export async function fx(q) {
  const from = code(q.from || "USD");
  if (!isCode(from)) throw badInput("from must be a 3-letter currency code, e.g. USD");
  const to = String(q.to ?? "").split(",").map(code).filter(Boolean);
  if (to.some((c) => !isCode(c))) throw badInput("to must be 3-letter currency codes, comma-separated, e.g. EUR,TRY");
  const amount = q.amount === undefined || q.amount === "" ? 1 : Number(q.amount);
  if (!Number.isFinite(amount) || amount < 0) throw badInput("amount must be a positive number");
  const date = isoDate(q.date, "date");
  const start = isoDate(q.start, "start");
  const end = isoDate(q.end, "end");
  if (end && !start) throw badInput("end needs start");
  const params = new URLSearchParams({ base: from, ...(to.length ? { symbols: to.join(",") } : {}) });
  const path = start ? `/${start}..${end ?? ""}` : `/${date ?? "latest"}`;
  const onStatus = async (r) => { if (r.status === 404 || r.status === 422) throw badInput("unknown currency code or a date outside the ECB series (1999-01-04 onward)"); };
  const data = await cached(`fx:${path}?${params}`, start || date ? 86400 : 1800, () => fetchJson(`${BASE}${path}?${params}`, { name: "The Frankfurter (ECB) rates API", onStatus }));
  if (!data?.rates) throw new ToolError(502, "The rates API returned no rates, you were not charged.");
  const scale = (rates) => Object.fromEntries(Object.entries(rates).map(([c, r]) => [c, Math.round(r * amount * 1e6) / 1e6]));
  if (start) {
    const days = Object.keys(data.rates).sort();
    const limit = clampInt(q.limit, 400, 1, 4000);
    return { base: from, amount, start: data.start_date, end: data.end_date, days: days.length, series: Object.fromEntries(days.slice(-limit).map((d) => [d, scale(data.rates[d])])), source: "European Central Bank reference rates via Frankfurter (https://frankfurter.dev)" };
  }
  return { base: from, amount, date: data.date, rates: data.rates, converted: amount === 1 ? undefined : scale(data.rates), note: "ECB reference rates are published on working days; weekends and holidays return the last published day.", source: "European Central Bank reference rates via Frankfurter (https://frankfurter.dev)" };
}
