// A fake Panta API with the response shapes from docs.panta.market (recorded in docs/PANTA.md).
// It sits behind the same fake fetch as the facilitators (helpers.js), so no test touches the network.
import { getAddressDecoder, getBase58Decoder } from "@solana/kit";
import { PANTA_URL } from "../lib/panta.js";
import { fullEnv, mockFacilitators, json } from "./helpers.js";

export const PANTA_KEY = "pk_test_mock_0123456789";
const addr = (n) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
export const WALLET = addr(7);
export const PROGRAM = addr(9);
export const BLOCKHASH = addr(40);
export const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(5));
export const IDS = { btc: addr(21), eth: addr(22), turnout: addr(23), etf: addr(24) };

const row = (o) => ({
  category: "crypto", description: "", images: ["https://cdn.example.com/m.png"], phase: "primary", marketType: "standard",
  startTime: 1767225600, endTime: 1798761599, resolutionTime: 1798765199, region: "Global", resolved: false, status: "open",
  volumeUsdc: "0.00", campaignId: null, createdByPartner: false,
  yesPrice: null, noPrice: null, primaryYesPrice: null, primaryNoPrice: null, secondaryYesPrice: null, secondaryNoPrice: null,
  ...o,
});

// GET /markets/ rows: prices are null on list rows.
export const CATALOG_ROWS = [
  row({ marketId: IDS.btc, title: "Will BTC close above $150k on 2026-12-31?", description: "Resolves YES if the CoinGecko daily close for BTC/USD on 2026-12-31 (UTC) is above $150,000.", volumeUsdc: "1200.00", oracle: "https://www.coingecko.com" }),
  row({ marketId: IDS.eth, title: "ETH above 5k?", description: "Resolves from CoinGecko.", volumeUsdc: "300.00" }),
  row({ marketId: IDS.turnout, category: "politics", title: "Will turnout exceed 60%?", phase: "secondary", volumeUsdc: "5000.00" }),
  row({ marketId: IDS.etf, title: "Bitcoin ETF approved by June?", phase: "resolved", resolved: true, status: "resolved", volumeUsdc: "9000.00" }),
];

// GET /markets/{id}/ rows: prices filled from chain state when Panta's RPC is available.
export const DETAIL = {
  [IDS.btc]: { yesPrice: "0.31", noPrice: "0.69", primaryYesPrice: "0.31", primaryNoPrice: "0.69" },
  [IDS.eth]: { yesPrice: "0.52", noPrice: "0.50", primaryYesPrice: "0.52", primaryNoPrice: "0.50" },
  [IDS.turnout]: {}, // RPC unavailable: prices stay null
  [IDS.etf]: {},
};

const HOUR = 3600;
export const TRADES = (marketId) => {
  const t = Math.floor(Date.now() / 1000);
  return {
    marketId,
    items: [
      { id: 3, marketId, wallet: addr(31), isPrimary: true, yesAmount: "10000000", noAmount: "0", feePaid: "40000", blockTime: t - HOUR, signature: SIGNATURE, quoteAsset: "USDC" },
      { id: 2, marketId, wallet: addr(32), isPrimary: true, yesAmount: "0", noAmount: "5000000", feePaid: "20000", blockTime: t - 2 * HOUR, signature: SIGNATURE, quoteAsset: "USDC" },
      { id: 1, marketId, wallet: addr(33), isPrimary: true, yesAmount: "2000000", noAmount: "0", feePaid: "8000", blockTime: t - 3 * 86400, signature: SIGNATURE, quoteAsset: "USDC" },
    ],
  };
};

export const quoteAnswer = (b) => ({
  quoteId: "qt_test1", marketId: b.marketId, side: b.side, amountUsdc: b.amountUsdc,
  shares: "15.80", avgPrice: "0.316456", feeUsdc: "0.10", expiresAt: "2026-09-30T12:01:30.000000Z", blockhashExpiryHintSec: 60,
});

export const buildAnswer = (b, marketId = IDS.btc) => ({
  orderId: "ord_test1", quoteId: b.quoteId, wallet: b.wallet, marketId, side: "yes", amountUsdc: "5.00",
  expectedShares: "15.80", feeUsdc: "0.10", status: "built",
  instructions: [
    {
      programId: PROGRAM, data: Buffer.from([1, 2, 3, 4]).toString("base64"),
      accounts: [
        { pubkey: b.wallet, isSigner: true, isWritable: true },
        { pubkey: marketId, isSigner: false, isWritable: true },
        { pubkey: addr(41), isSigner: false, isWritable: false },
      ],
    },
    { programId: addr(42), data: Buffer.from("sitecheck").toString("base64"), accounts: [{ pubkey: b.wallet, isSigner: true, isWritable: false }] },
  ],
  derived: { event: marketId, vaultAuthority: addr(43) },
  recentBlockhash: BLOCKHASH, lastValidBlockHeight: 123456789, expiresAt: "2026-09-30T12:02:00.000000Z", blockhashExpiryHintSec: 60,
});

const DEFAULTS = {
  "GET /markets/": (call, url) => {
    const status = url.searchParams.get("status");
    const rows = CATALOG_ROWS.filter((m) => !status || m.phase === status);
    // Two pages, to check that the cursor is followed.
    return url.searchParams.get("cursor") === "page2" ? { items: rows.slice(2), nextCursor: null } : { items: rows.slice(0, 2), nextCursor: rows.length > 2 ? "page2" : null };
  },
  "GET /markets/{id}/": (call, url, id) => {
    const base = CATALOG_ROWS.find((m) => m.marketId === id);
    return base ? { ...base, ...DETAIL[id] } : json({ code: "MARKET_NOT_FOUND", message: "Market account missing or undecodable" }, 404);
  },
  "GET /markets/{id}/trades/": (call, url, id) => TRADES(id),
  "POST /primaryorderquote/": (call) => quoteAnswer(call.body),
  "POST /primaryorderbuild/": (call) => buildAnswer(call.body),
  "POST /primaryordersubmit/": (call) => ({ orderId: call.body.orderId, status: "submitted", signature: call.body.signature }),
  "POST /trades/": (call) => ({ signature: call.body.signature, status: "processed", marketId: call.body.marketId, wallet: call.body.wallet, side: "yes", kind: "buy" }),
};

// overrides: { "POST /primaryorderquote/": (call, url, id) => Response | object } replaces a default.
// Returns the facilitator mock plus panta(): the Panta calls made so far.
export function mockPanta(t, overrides = {}, options = {}) {
  const routes = { ...DEFAULTS, ...overrides };
  const fx = mockFacilitators(t, {
    ...options,
    async handle(call) {
      if (!call.url.startsWith(PANTA_URL)) return undefined;
      const url = new URL(call.url);
      const path = url.pathname.slice(new URL(PANTA_URL).pathname.length);
      const m = path.match(/^\/markets\/([^/]+)\/(trades\/)?$/);
      const key = `${call.method} ${m ? `/markets/{id}/${m[2] || ""}` : path}`;
      if (call.headers["x-api-key"] !== PANTA_KEY) return json({ code: "UNAUTHORIZED", message: "authentication required" }, 401);
      const fn = routes[key];
      if (!fn) return new Response("<!doctype html><title>Not Found</title>", { status: 404, headers: { "content-type": "text/html" } });
      const answer = await fn(call, url, m && decodeURIComponent(m[1]));
      return answer instanceof Response ? answer : json(answer);
    },
  });
  return { ...fx, panta: () => fx.calls.filter((c) => c.url.startsWith(PANTA_URL)) };
}

// Workers AI stand-in: the chat model answers `text` (or throws it if it is an Error).
export const chatAI = (text, seen = []) => ({
  run: async (model, input) => {
    seen.push({ model, input });
    if (text instanceof Error) throw text;
    return { response: text, usage: { prompt_tokens: 100, completion_tokens: 60 } };
  },
});

export const NEUTRAL = "This market asks whether BTC will close above $150,000 on 2026-12-31. It resolves from the CoinGecko daily close. YES trades at 0.31 USDC, so the market implies about a 31% chance.";
export const pantaEnv = (extra = {}) => fullEnv({ PANTA_API_KEY: PANTA_KEY, AI: chatAI(NEUTRAL), ...extra });
