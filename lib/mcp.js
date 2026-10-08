// POST /mcp: a remote MCP server (Streamable HTTP, stateless, JSON answers) that exposes every paid route as an MCP tool.
// Payment follows the x402 MCP transport (as in @x402/mcp): an unpaid tools/call answers isError with the x402
// PaymentRequired object in structuredContent (and as JSON text); the client repeats the call with the signed
// PaymentPayload in params._meta["x402/payment"], and a paid answer carries the settlement in
// result._meta["x402/payment-response"]. Each tool call is replayed against the matching /api route inside this
// Worker, so the same middleware verifies the payment and settles it only when the call succeeds.
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const PAYMENT_META = "x402/payment";
export const PAYMENT_RESPONSE_META = "x402/payment-response";

const b64json = (s) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))));
const tob64 = (obj) => { const bytes = new TextEncoder().encode(JSON.stringify(obj)); let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };

/** "GET /api/solana/token" -> "solana_token" */
export const toolName = (route) => route.split(" ")[1].replace(/^\/api\//, "").replace(/[/-]/g, "_");

export function toolList(catalog) {
  return Object.entries(catalog).map(([route, t]) => ({
    name: toolName(route),
    title: toolName(route).replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
    description: `${t.description} Price: ${t.price} in USDC per successful call, paid with x402 (Base, Solana or Arc); failed calls are not charged.`,
    inputSchema: { type: "object", properties: t.inputSchema?.properties ?? {}, ...(t.inputSchema?.required?.length ? { required: t.inputSchema.required } : {}) },
    annotations: { readOnlyHint: !route.includes("build-buy"), openWorldHint: true },
    _meta: { "x402/price": t.price, "x402/route": route },
  }));
}

const textResult = (obj, isError = false, meta) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }], ...(obj && typeof obj === "object" && !Array.isArray(obj) ? { structuredContent: obj } : {}), ...(isError ? { isError: true } : {}), ...(meta ? { _meta: meta } : {}) });

/** One tools/call: replays the route through `call(request)` (the Worker's own fetch) and maps 402/2xx/errors to MCP results. */
export async function callTool({ catalog, origin, call }, params) {
  const entry = Object.entries(catalog).find(([route]) => toolName(route) === params?.name);
  if (!entry) return { error: { code: -32602, message: `Unknown tool: ${params?.name}` } };
  const [route] = entry;
  const [method, path] = route.split(" ");
  const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
  const headers = { accept: "application/json" };
  const payment = params._meta?.[PAYMENT_META];
  if (payment) headers["PAYMENT-SIGNATURE"] = typeof payment === "string" ? payment : tob64(payment);
  let url = `${origin}${path}`, body;
  if (method === "GET") {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null && v !== "") qs.set(k, Array.isArray(v) ? v.join(",") : String(v));
    if ([...qs].length) url += `?${qs}`;
  } else { headers["content-type"] = "application/json"; body = JSON.stringify(args); }
  const res = await call(new Request(url, { method, headers, body }));
  if (res.status === 402) {
    const header = res.headers.get("payment-required");
    let paymentRequired;
    try { paymentRequired = header ? b64json(header) : await res.json(); } catch { paymentRequired = null; }
    if (!paymentRequired) return { result: textResult({ error: "Payment required, but the payment requirements could not be read." }, true) };
    return { result: textResult(paymentRequired, true) };
  }
  let out;
  try { out = await res.json(); } catch { out = { error: `HTTP ${res.status}` }; }
  if (res.status >= 400) return { result: textResult({ ...out, status: res.status, charged: false }, true) };
  const settled = res.headers.get("payment-response");
  let receipt;
  try { receipt = settled ? b64json(settled) : undefined; } catch { receipt = undefined; }
  return { result: textResult(out, false, receipt ? { [PAYMENT_RESPONSE_META]: receipt } : undefined) };
}

const INSTRUCTIONS = "SiteCheck: pay-per-call tools for agents (web page to Markdown, PDF to text, tech stack, sitemap, e-mail pre-check, domain RDAP, exchange rates, translation, Solana token/wallet data, EU VAT, IBAN, LEI, US recalls, OSHA/EPA, UK insolvency, AI image/speech/chat). Every tool is paid in USDC with x402 (Base, Solana or Arc). Call a tool without payment to get its x402 PaymentRequired object, sign one option with your wallet and repeat the call with the PaymentPayload in params._meta[\"x402/payment\"] (x402 MCP transport, e.g. @x402/mcp's createx402MCPClient). Payment settles only when the call succeeds. No account or API key.";

/** Handles one JSON-RPC message; returns the response object, or null for notifications. */
export async function handleRpc(ctx, msg) {
  const id = msg?.id;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid Request");
  if (id === undefined) return null; // notification (e.g. notifications/initialized)
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "sitecheck", title: "SiteCheck (x402 pay-per-call tools)", version: ctx.version, websiteUrl: ctx.origin }, instructions: INSTRUCTIONS });
    }
    case "ping": return reply({});
    case "tools/list": return reply({ tools: toolList(ctx.catalog) });
    case "tools/call": { const r = await callTool(ctx, msg.params); return r.error ? fail(r.error.code, r.error.message) : reply(r.result); }
    case "resources/list": return reply({ resources: [] });
    case "resources/templates/list": return reply({ resourceTemplates: [] });
    case "prompts/list": return reply({ prompts: [] });
    default: return fail(-32601, `Method not found: ${msg.method}`);
  }
}
