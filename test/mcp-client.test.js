// Compatibility with the official x402 MCP client (@x402/mcp + the MCP TypeScript SDK's Streamable HTTP transport).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { fullEnv, mockFacilitators, createApp, BASE } from "./helpers.js";

test("createx402MCPClient lists the tools, pays for a call and gets the result", async (t) => {
  const fx = mockFacilitators(t);
  const app = createApp(), env = fullEnv();
  const realFetch = globalThis.fetch;
  // Requests to the MCP server go to the in-memory app; everything else (facilitator mocks) to the mocked fetch.
  const fetchToApp = (url, init) => (String(url).startsWith("https://sitecheck.test/") ? app.request(String(url).replace("https://sitecheck.test", ""), init, env) : realFetch(url, init));
  let asked = 0;
  const client = createx402MCPClient({
    name: "test-agent", version: "1.0.0",
    schemes: [{ network: BASE, client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }],
    autoPayment: true,
    onPaymentRequested: async () => { asked++; return true; },
  });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://sitecheck.test/mcp"), { fetch: fetchToApp }));
  const { tools } = await client.listTools();
  assert.ok(tools.find((x) => x.name === "iban"));
  const r = await client.callTool("iban", { iban: "GB29 NWBK 6016 1331 9268 19" });
  assert.equal(asked, 1);
  assert.equal(r.isError, undefined);
  assert.equal(JSON.parse(r.content[0].text).valid, true);
  assert.equal(r.paymentMade, true);
  assert.equal(fx.settles().length, 1);
  await client.close();
});
