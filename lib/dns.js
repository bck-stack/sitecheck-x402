// DNS over HTTPS (JSON API), shared by /api/email-check and /api/domain. Resolvers are tried in order:
// a resolver that errors or answers without a body is skipped. Results: { status: ok|nxdomain|fail, data[] }.
import { UA } from "./upstream.js";

export const DOH_URLS = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve", "https://1.1.1.1/dns-query"];
const TYPES = { A: 1, NS: 2, MX: 15, TXT: 16, AAAA: 28 };

export async function dnsQuery(name, type, { timeout = 5000 } = {}) {
  for (const base of DOH_URLS) {
    try {
      const res = await fetch(`${base}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json", "user-agent": UA }, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.Status === 3) return { status: "nxdomain", data: [] };
      if (data.Status !== 0) continue;
      return { status: "ok", data: (data.Answer || []).filter((a) => a.type === TYPES[type]).map((a) => String(a.data)) };
    } catch { /* next resolver */ }
  }
  return { status: "fail", data: [] };
}

/** MX hosts sorted by preference ("10 mx.example.com." -> mx.example.com); a lone "0 ." is a null MX. */
export function parseMx(records) {
  const parsed = records.map((r) => /^\s*(\d+)\s+(\S+)\s*$/.exec(r)).filter(Boolean).map((m) => ({ pref: Number(m[1]), host: m[2].toLowerCase().replace(/\.$/, "") }));
  const hosts = parsed.filter((p) => p.host).sort((a, b) => a.pref - b.pref).map((p) => p.host);
  return { hosts, nullMx: parsed.length > 0 && hosts.length === 0 };
}

/** Can the domain receive mail? MX first; no MX falls back to A/AAAA (RFC 5321 implicit MX). mx null = DNS did not answer. */
export async function lookupMail(domain) {
  const mx = await dnsQuery(domain, "MX");
  if (mx.status === "nxdomain") return { mx: false, mxHosts: [], nxdomain: true, nullMx: false };
  if (mx.status === "fail") return { mx: null, mxHosts: [], nxdomain: false, nullMx: false };
  const { hosts, nullMx } = parseMx(mx.data);
  if (hosts.length) return { mx: true, mxHosts: hosts.slice(0, 3), nxdomain: false, nullMx: false };
  if (nullMx) return { mx: false, mxHosts: [], nxdomain: false, nullMx: true };
  const [a, aaaa] = await Promise.all([dnsQuery(domain, "A"), dnsQuery(domain, "AAAA")]);
  if (a.data.length || aaaa.data.length) return { mx: true, mxHosts: [], nxdomain: false, nullMx: false };
  if (a.status === "fail" && aaaa.status === "fail") return { mx: null, mxHosts: [], nxdomain: false, nullMx: false };
  return { mx: false, mxHosts: [], nxdomain: false, nullMx: false };
}
