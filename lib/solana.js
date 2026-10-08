// Solana token data for trading agents. Information only, never advice; nothing is signed or sent.
// GET /api/solana/token: one SPL token: price, market cap, liquidity, holders, 24h trading, organic score and audit
//   (Jupiter token API), top pools (GeckoTerminal, best effort), and mint/freeze authority, supply, token program and
//   Token-2022 extensions read on chain (Solana JSON-RPC), with red flags.
// GET /api/solana/trending: trending, newest or top-organic Solana tokens (Jupiter) with the same audit fields and flags.
import { badInput, cached, clampInt, fetchJson, ToolError, upstreamDown } from "./upstream.js";

const JUP = "https://lite-api.jup.ag/tokens/v2";
const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
// Public RPCs, tried in order (api.mainnet-beta.solana.com refuses Cloudflare Workers with 403). SOLANA_RPC_URL goes first when set.
const RPCS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PJnBCivJ7fH1W6";
export const DISCLAIMER = "Information only, not financial advice.";
export const isSolanaAddress = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s ?? ""));

const num = (v) => { const n = typeof v === "string" ? Number(v) : v; return Number.isFinite(n) ? n : null; };
const strip = (id) => String(id ?? "").replace(/^solana_/, "");
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

async function rpc(env, method, params) {
  let last;
  for (const url of [env?.SOLANA_RPC_URL, ...RPCS].filter(Boolean)) {
    try {
      const body = await fetchJson(url, { name: "Solana RPC", timeout: 8000, init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) } });
      if (body?.error) { last = upstreamDown("Solana RPC", `answered "${String(body.error.message || "error").slice(0, 80)}"`); continue; }
      return body?.result;
    } catch (e) { if (!(e instanceof ToolError)) throw e; last = e; }
  }
  throw last ?? upstreamDown("Solana RPC");
}

/** Mint facts from a jsonParsed account (or null when the account is not an SPL mint). */
export function mintInfo(account) {
  const info = account?.data?.parsed?.type === "mint" ? account.data.parsed.info : null;
  if (!info) return null;
  const decimals = info.decimals ?? 0;
  return {
    program: account.owner === TOKEN_2022 ? "token-2022" : "spl-token",
    decimals, supply: info.supply != null ? Number(info.supply) / 10 ** decimals : null,
    mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null,
    mintAuthorityEnabled: !!info.mintAuthority, freezeAuthorityEnabled: !!info.freezeAuthority,
    extensions: (info.extensions || []).map((e) => e.extension).filter(Boolean),
  };
}

/** One Jupiter token object to a flat row. */
export function tokenRow(t, now = Date.now()) {
  const s = t.stats24h ?? {}, h1 = t.stats1h ?? {};
  const firstPool = t.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : NaN;
  const a = t.audit ?? {};
  return {
    address: t.id, name: t.name ?? null, symbol: t.symbol ?? null,
    priceUsd: num(t.usdPrice), marketCapUsd: num(t.mcap), fdvUsd: num(t.fdv), liquidityUsd: round(num(t.liquidity)),
    holders: num(t.holderCount),
    volume24hUsd: round((num(s.buyVolume) ?? 0) + (num(s.sellVolume) ?? 0)),
    priceChangePct: { h1: round(num(h1.priceChange)), h24: round(num(s.priceChange)) },
    trades24h: { buys: num(s.numBuys), sells: num(s.numSells), traders: num(s.numTraders) },
    organicScore: round(num(t.organicScore), 1), organicScoreLabel: t.organicScoreLabel ?? null,
    verified: !!t.isVerified, tags: t.tags ?? [],
    tokenProgram: t.tokenProgram === TOKEN_2022 ? "token-2022" : t.tokenProgram ? "spl-token" : null,
    mintAuthorityEnabled: a.mintAuthorityDisabled === undefined ? (t.mintAuthority ? true : null) : !a.mintAuthorityDisabled,
    freezeAuthorityEnabled: a.freezeAuthorityDisabled === undefined ? (t.freezeAuthority ? true : null) : !a.freezeAuthorityDisabled,
    topHoldersPercent: round(num(a.topHoldersPercentage)), devBalancePercent: round(num(a.devBalancePercentage), 4),
    firstPoolCreatedAt: Number.isFinite(firstPool) ? new Date(firstPool).toISOString() : null,
    ageHours: Number.isFinite(firstPool) ? round((now - firstPool) / 3600000, 1) : null,
    url: `https://jup.ag/tokens/${t.id}`,
  };
}

/** Red flags an agent should look at before touching a token. */
export function flagsFor(r, mint = null) {
  const f = [];
  if (mint ? mint.mintAuthorityEnabled : r.mintAuthorityEnabled) f.push("mint-authority-enabled: more tokens can be created");
  if (mint ? mint.freezeAuthorityEnabled : r.freezeAuthorityEnabled) f.push("freeze-authority-enabled: holders' tokens can be frozen");
  if (mint?.extensions?.some((e) => /transferFee|permanentDelegate|transferHook|defaultAccountState|nonTransferable/i.test(e))) f.push(`token-2022 extensions: ${mint.extensions.join(", ")}`);
  if (r.topHoldersPercent != null && r.topHoldersPercent > 50) f.push(`concentrated: top holders own ${r.topHoldersPercent}%`);
  if (r.liquidityUsd != null && r.liquidityUsd < 10000) f.push("low-liquidity: under $10k");
  if (r.ageHours != null && r.ageHours < 24) f.push("new: first pool less than 24 hours old");
  if (r.trades24h?.sells === 0 && (r.trades24h?.buys ?? 0) > 20) f.push("no-sells-in-24h: possible honeypot");
  if (r.organicScoreLabel === "low") f.push("low-organic-score: trading looks mostly automated");
  return f;
}

/** GeckoTerminal pools of a token (best effort: its public API rate-limits shared IPs). */
export function poolRows(body, now = Date.now()) {
  return (body?.data ?? []).filter((p) => p?.type === "pool" && p.attributes?.address).map((p) => {
    const a = p.attributes;
    const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
    return {
      pairAddress: a.address, name: a.name ?? null, dex: strip(p.relationships?.dex?.data?.id) || null,
      liquidityUsd: round(num(a.reserve_in_usd)), volume24hUsd: round(num(a.volume_usd?.h24)), priceUsd: num(a.base_token_price_usd),
      createdAt: Number.isFinite(created) ? new Date(created).toISOString() : null,
      url: `https://www.geckoterminal.com/solana/pools/${a.address}`,
    };
  });
}

const jup = (path, ttl) => cached(`jup:${path}`, ttl, () => fetchJson(`${JUP}${path}`, { name: "Jupiter token API", timeout: 10000 }));

export async function solanaToken(q, env) {
  const address = String(q.address ?? q.mint ?? "").trim();
  if (!isSolanaAddress(address)) throw badInput("address must be a Solana token mint address (base58)");
  const [account, list, pools] = await Promise.all([
    rpc(env, "getAccountInfo", [address, { encoding: "jsonParsed" }]).catch((e) => { if (e instanceof ToolError) return { failed: e.message }; throw e; }),
    jup(`/search?query=${address}`, 30).catch((e) => { if (e instanceof ToolError) return { failed: e.message }; throw e; }),
    cached(`gt:pools:${address}`, 120, () => fetchJson(`${GT}/tokens/${address}/pools?include=dex&page=1`, { name: "GeckoTerminal", timeout: 6000 })).catch(() => null),
  ]);
  const t = Array.isArray(list) ? list.find((x) => x.id === address) : null;
  if (account?.failed && !t) throw upstreamDown("Solana RPC and the Jupiter token API", "did not answer");
  if (!account?.failed && !account?.value) throw new ToolError(404, "No account at this address on Solana mainnet; you were not charged.");
  const mint = account?.failed ? null : mintInfo(account.value);
  if (!account?.failed && !mint) throw badInput("This address is not an SPL token mint (it may be a wallet or a pool address)");
  const row = t ? tokenRow(t) : { address };
  return {
    ...row,
    ...(mint ? { tokenProgram: mint.program, decimals: mint.decimals, supply: mint.supply, mintAuthority: mint.mintAuthority, freezeAuthority: mint.freezeAuthority, mintAuthorityEnabled: mint.mintAuthorityEnabled, freezeAuthorityEnabled: mint.freezeAuthorityEnabled, extensions: mint.extensions } : {}),
    topPools: poolRows(pools).slice(0, 5),
    flags: flagsFor(row, mint),
    checks: { onchain: mint ? "ok" : `unavailable (${account?.failed})`, market: t ? "jupiter" : Array.isArray(list) ? "token not listed on Jupiter" : `unavailable (${list?.failed})`, pools: pools ? "geckoterminal" : "unavailable" },
    disclaimer: DISCLAIMER,
    sources: ["Solana mainnet JSON-RPC (getAccountInfo)", "Jupiter token API (https://jup.ag)", "GeckoTerminal (https://www.geckoterminal.com)"],
  };
}

const MODES = { trending: "/toptrending/", organic: "/toporganicscore/", traded: "/toptraded/" };
export async function solanaTrending(q) {
  const mode = q.mode === "new" ? "new" : MODES[q.mode] ? q.mode : "trending";
  const interval = ["5m", "1h", "6h", "24h"].includes(q.interval) ? q.interval : "1h";
  const minLiquidity = Math.max(0, num(q.minLiquidityUsd) ?? (mode === "new" ? 5000 : 50000));
  const minVolume = Math.max(0, num(q.minVolume24hUsd) ?? 0);
  const limit = clampInt(q.limit, 20, 1, 100);
  const list = await jup(mode === "new" ? "/recent?limit=100" : `${MODES[mode]}${interval}?limit=100`, 30);
  if (!Array.isArray(list)) throw upstreamDown("Jupiter token API", "returned an unreadable list");
  const now = Date.now();
  const rows = list.map((t) => tokenRow(t, now));
  const results = rows.filter((r) => (r.liquidityUsd ?? 0) >= minLiquidity && (r.volume24hUsd ?? 0) >= minVolume).slice(0, limit).map((r) => ({ ...r, flags: flagsFor(r) }));
  return { mode, interval: mode === "new" ? null : interval, filters: { minLiquidityUsd: minLiquidity, minVolume24hUsd: minVolume }, looked: rows.length, returned: results.length, results, disclaimer: DISCLAIMER, source: "Jupiter token API (https://jup.ag)" };
}
