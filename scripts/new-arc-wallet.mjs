// Creates the dedicated Arc receiving ("hot") wallet for Circle's keyless trial.
//
//   node scripts/new-arc-wallet.mjs
//
// The private key goes into .env.arc-seller (git-ignored, readable only by you) and is never printed.
// The script prints the address and the next commands. It never overwrites an existing
// .env.arc-seller, because that file may be the only copy of a key that still holds USDC.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const NAME = ".env.arc-seller";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE = fileURLToPath(new URL(`../${NAME}`, import.meta.url));

if (existsSync(FILE)) {
  const key = /^ARC_SELLER_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(FILE, "utf8"))?.[1];
  console.error(`${NAME} already exists${key ? ` (wallet ${privateKeyToAccount(key).address})` : ""}; not overwriting it.`);
  console.error("If you really want a new wallet, sweep the old one first (scripts/sweep-arc.mjs), then move the file away.");
  process.exit(1);
}

// Refuse to write a key where git would pick it up. (.gitignore has `.env*`.)
try {
  execFileSync("git", ["check-ignore", "-q", NAME], { cwd: ROOT, stdio: "ignore" });
} catch (e) {
  if (e.status === 1) {
    console.error(`${NAME} is not git-ignored here; add ".env*" to .gitignore first.`);
    process.exit(1);
  }
  // git not installed or not a checkout: nothing to check against.
}

const key = generatePrivateKey();
const { address } = privateKeyToAccount(key);
writeFileSync(FILE, [
  `# SiteCheck: Arc receiving (hot) wallet for Circle's keyless trial. Created ${new Date().toISOString()}.`,
  "# Keep this file private. It is git-ignored: never commit, share or paste it anywhere except `wrangler secret put`.",
  `# Address: ${address}`,
  `ARC_SELLER_KEY=${key}`,
  "",
].join("\n"), { mode: 0o600, flag: "wx" });

console.log(`Arc receiving wallet created: ${address}
The private key is in ${NAME} (not printed).

1. Store the key as a Worker secret. When wrangler asks for the value, paste the text after
   "ARC_SELLER_KEY=" in ${NAME} (0x followed by 64 hex characters):

   npx wrangler secret put ARC_SELLER_KEY

   Leave PAY_TO_ARC empty: the Worker derives ${address} from the key.
   (If you set PAY_TO_ARC, it must be exactly this address, or Arc is switched off.)

2. Sweep the collected USDC to your own cold wallet regularly. The first command only shows what
   would be sent; add --yes to send it:

   node scripts/sweep-arc.mjs --to <your cold Arc address>
   node scripts/sweep-arc.mjs --to <your cold Arc address> --yes

Keep a private backup of ${NAME} (for example in a password manager) until the wallet is retired.`);
