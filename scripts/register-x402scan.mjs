// Register this origin on x402scan. Signs in with a throwaway, unfunded signing wallet (.env.kayit, never committed).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
let pk = existsSync(".env.kayit") ? readFileSync(".env.kayit", "utf8").trim() : null;
if (!pk) { pk = generatePrivateKey(); writeFileSync(".env.kayit", pk); }
const account = privateKeyToAccount(pk);
const URL_ = "https://www.x402scan.com/api/x402/registry/register-origin";
const body = JSON.stringify({ origin: process.argv[2] || "https://sitecheck-api.vercel.app" });
const opts = { method: "POST", headers: { "content-type": "application/json" }, body };
const r1 = await fetch(URL_, opts);
const pr = await r1.json();
const ext = pr.extensions["sign-in-with-x"];
const info = { ...ext.info, chainId: ext.supportedChains[0].chainId, type: ext.supportedChains[0].type };
const header = encodeSIWxHeader(await createSIWxPayload(info, account, URL_));
const r2 = await fetch(URL_, { ...opts, headers: { ...opts.headers, "sign-in-with-x": header } });
console.log(r2.status, (await r2.text()).slice(0, 3000));
