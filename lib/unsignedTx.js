// Compiles Panta's buy instructions into an unsigned Solana v0 transaction, as a convenience for agents.
// Panta's build returns instructions plus a recent blockhash; the playground compiles them the same way
// (TransactionMessage.compileToV0Message, no lookup tables). The fee payer is the buyer's wallet, and
// every signature slot stays empty: SiteCheck has no key to sign with and never asks for one.
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  getBase64EncodedWireTransaction, getBase64Encoder, getTransactionDecoder, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

const role = (a) => a.isSigner
  ? (a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER)
  : (a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY);

// instructions: [{ programId, data (base64), accounts: [{ pubkey, isSigner, isWritable }] }] as Panta returns them.
// Returns the base64 wire transaction; throws if an address or the blockhash is malformed.
export function compileUnsigned(instructions, feePayer, recentBlockhash, lastValidBlockHeight = 0) {
  const ixs = instructions.map((ix) => ({
    programAddress: address(ix.programId),
    accounts: ix.accounts.map((a) => ({ address: address(a.pubkey), role: role(a) })),
    data: new Uint8Array(getBase64Encoder().encode(ix.data)),
  }));
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: recentBlockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight || 0) }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const wire = getBase64EncodedWireTransaction(compileTransaction(message));
  if (signedBy(wire).length) throw new Error("refusing to return a signed transaction"); // cannot happen: nothing here signs
  return wire;
}

// Addresses whose signature slot in a base64 wire transaction is filled (all-zero slots decode as null).
export function signedBy(wire) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  return Object.entries(tx.signatures).filter(([, sig]) => sig && sig.some((b) => b !== 0)).map(([who]) => who);
}
