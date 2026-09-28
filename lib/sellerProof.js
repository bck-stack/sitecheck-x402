// Circle Facilitator Service seller proof, for the keyless trial on Arc.
// Without an API key, every /verify, /settle and /status request carries a Facilitator-Seller-Proof
// header: an EIP-712 SellerRequest signature by the key that controls payTo, over the route, the
// HTTP method and the keccak256 of the raw request body. Circle rebuilds the message from the request
// and the envelope, so the proof only works for the exact bytes it was made for.
// Spec: https://developers.circle.com/facilitator-service/sign-seller-proof
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const SELLER_PROOF_HEADER = "Facilitator-Seller-Proof";
const PROOF_TTL_SECONDS = 300; // Circle's maximum: expiresAt at most 5 minutes after issuedAt

const SELLER_REQUEST_TYPES = {
  SellerRequest: [
    { name: "purpose", type: "string" },
    { name: "method", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "network", type: "string" },
    { name: "payTo", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
};

// "eip155:5042" -> 5042
function chainIdOf(network) {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new Error(`seller proofs need an eip155 network, got ${network}`);
  return Number(m[1]);
}

const sellerDomain = (network) => ({ name: "Circle Facilitator Seller Request", version: "1", chainId: chainIdOf(network) });

// The signed message. `body` is the raw request body as bytes (empty for GET).
const sellerRequest = ({ purpose, method, body, network, payTo, nonce, issuedAt, expiresAt }) => ({
  purpose, method: method.toUpperCase(), bodyHash: keccak256(body), network, payTo, nonce, issuedAt: BigInt(issuedAt), expiresAt: BigInt(expiresAt),
});

// Returns the header value: the base64url-encoded JSON envelope. Every call gets a fresh random nonce.
export async function sellerProof(account, { purpose, method = "POST", body = new Uint8Array(), network, payTo }) {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + PROOF_TTL_SECONDS;
  const message = sellerRequest({ purpose, method, body, network, payTo, nonce, issuedAt, expiresAt });
  const signature = await account.signTypedData({ domain: sellerDomain(network), types: SELLER_REQUEST_TYPES, primaryType: "SellerRequest", message });
  const envelope = JSON.stringify({ version: 1, signature, network, payTo, nonce, issuedAt, expiresAt });
  return btoa(envelope).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); // the envelope is ASCII
}

// ARC_SELLER_KEY -> viem account, or null if it is not a 32-byte hex private key.
// Never echoes the key: callers turn null into a generic message.
export function sellerAccount(key) {
  const hex = String(key ?? "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  try { return privateKeyToAccount(`0x${hex.toLowerCase()}`); }
  catch { return null; }
}
