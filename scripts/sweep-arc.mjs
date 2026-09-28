// Moves all USDC collected by the Arc receiving (hot) wallet to your own cold address.
//
//   node scripts/sweep-arc.mjs --to 0xCOLD          # shows what would be sent, sends nothing
//   node scripts/sweep-arc.mjs --to 0xCOLD --yes    # sends it
//   [--rpc https://...]                             # default: ARC_RPC_URL or https://rpc.mainnet.arc.io
//
// The key comes from the ARC_SELLER_KEY environment variable, else from .env.arc-seller
// (written by scripts/new-arc-wallet.mjs).
//
// On Arc, USDC is the gas token: the ERC-20 at 0x3600…0000 (6 decimals) and the native balance
// (18 decimals) are one balance. An ERC-20 `transfer` of the whole balance fails because the gas
// comes out of that same balance, and the 6-decimal view hides the sub-micro-USDC remainder, which
// would stay behind. So the sweep is a plain native transfer of balance - fee, with the fee fixed up
// front (maxFeePerGas = maxPriorityFeePerGas, so the network charges exactly gasUsed x that price
// and refunds nothing): the wallet ends at exactly 0.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, isAddress, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "viem/chains";

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith("--") ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]] : null).filter(Boolean));
const fail = (msg) => { console.error(msg); process.exit(1); };
const usdc = (wei) => `${formatUnits(wei, 18)} USDC`;

const RPC = String(args.rpc || process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io");
const USDC_ERC20 = "0x3600000000000000000000000000000000000000";
const MIN_FEE = parseGwei("20"); // Arc's mempool silently drops transactions below this maxFeePerGas

// 1. The hot wallet.
const FILE = fileURLToPath(new URL("../.env.arc-seller", import.meta.url));
let key = String(process.env.ARC_SELLER_KEY ?? "").trim();
if (!key && existsSync(FILE)) key = /^ARC_SELLER_KEY=(\S+)\s*$/m.exec(readFileSync(FILE, "utf8"))?.[1] ?? "";
if (!key) fail("No key: set ARC_SELLER_KEY or create .env.arc-seller with scripts/new-arc-wallet.mjs.");
if (!key.startsWith("0x")) key = `0x${key}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail("ARC_SELLER_KEY is not a 32-byte hex private key.");
const account = privateKeyToAccount(key);

// 2. The destination.
if (typeof args.to !== "string") fail("usage: node scripts/sweep-arc.mjs --to 0xYourColdAddress [--yes] [--rpc URL]");
if (!isAddress(args.to)) fail(`--to ${args.to} is not a valid address (a mixed-case address must have a correct checksum).`);
const to = getAddress(args.to);
if (to === account.address) fail("--to is the hot wallet itself.");
if (BigInt(to) < 0x10000n || to === getAddress(USDC_ERC20)) fail(`--to ${to} is a zero, precompile or system address; native USDC sent there reverts or is lost.`);

const pub = createPublicClient({ chain: arc, transport: http(RPC) });
const chainId = await pub.getChainId();
if (chainId !== arc.id) fail(`${RPC} is chain ${chainId}, not Arc mainnet (${arc.id}).`);

// 3. What to send: everything minus a fee fixed in advance.
const balance = await pub.getBalance({ address: account.address });
if (balance === 0n) fail(`Hot wallet ${account.address} is empty; nothing to sweep.`);
const code = await pub.getCode({ address: to });
const gas = await pub.estimateGas({ account: account.address, to, value: 1n });
const gasPrice = await pub.getGasPrice();
// Twice the current price, so a base-fee rise before inclusion can't strand the transaction.
// Arc smooths its base fee, and at its 20 gwei floor this whole fee is about 0.0008 USDC.
const price = 2n * (gasPrice > MIN_FEE ? gasPrice : MIN_FEE);
const fee = gas * price;
const value = balance - fee;

console.log(`Hot wallet  ${account.address}
Balance     ${usdc(balance)}
Destination ${to}${code && code !== "0x" ? " (a contract: it must accept native USDC; any unused gas stays behind as dust)" : ""}
Fee         ${usdc(fee)} (${gas} gas x ${formatUnits(price, 9)} gwei)
Send        ${value > 0n ? usdc(value) : "nothing"}`);
if (value <= 0n) fail("\nNothing to sweep: the balance does not cover the fee.");
if (args.yes !== true) {
  console.log("\nDry run: nothing sent. Check the destination, then run again with --yes.");
  process.exit(0);
}

// 4. Send and confirm. Arc finalizes on inclusion.
const wallet = createWalletClient({ account, chain: arc, transport: http(RPC) });
const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
const hash = await wallet.sendTransaction({ to, value, gas, maxFeePerGas: price, maxPriorityFeePerGas: price, nonce });
console.log(`\nSent: ${arc.blockExplorers.default.url}/tx/${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") fail(`The transfer reverted (the gas was still charged). Does ${to} accept native USDC?`);
const left = await pub.getBalance({ address: account.address });
console.log(`Done in block ${receipt.blockNumber}. Left in the hot wallet: ${usdc(left)}${left > 0n ? " (payments that arrived meanwhile, or unused gas from a contract destination; sweep again later)" : ""}`);
