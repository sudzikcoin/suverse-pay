import { Keypair } from "@solana/web3.js";
import { mnemonicToSeedSync, validateMnemonic } from "bip39";
import { derivePath } from "ed25519-hd-key";
import bs58 from "bs58";

/**
 * Solana's BIP-44 derivation path. Phantom, Solflare, Backpack, and the
 * `solana-keygen` CLI all default to this path; the result of importing
 * the same BIP-39 mnemonic into any of them matches what
 * `deriveKeypairFromMnemonic` produces here.
 */
export const SOLANA_HD_PATH = "m/44'/501'/0'/0'";

/**
 * Derive a Solana `Keypair` from a BIP-39 mnemonic. Uses SLIP-0010
 * ed25519 HD derivation (every level hardened) — the standard for
 * Solana wallets.
 *
 * The function validates the mnemonic word count + checksum before
 * deriving so a corrupted secret is caught immediately rather than
 * silently producing a Keypair for a different wallet.
 */
export function deriveKeypairFromMnemonic(mnemonic: string): Keypair {
  if (!validateMnemonic(mnemonic.trim())) {
    throw new Error("invalid mnemonic: failed BIP-39 checksum / word-list validation");
  }
  // ed25519-hd-key expects the seed as a hex string.
  const seedHex = mnemonicToSeedSync(mnemonic.trim()).toString("hex");
  const { key } = derivePath(SOLANA_HD_PATH, seedHex);
  // `key` is the 32-byte private scalar; Keypair.fromSeed wraps it
  // with the corresponding ed25519 public key.
  return Keypair.fromSeed(key);
}

/**
 * Decode a base58-encoded 64-byte Solana secret key (the standard
 * format `solana-keygen` writes: 32-byte private key || 32-byte public
 * key) into a `Keypair`.
 *
 * Throws if the input doesn't base58-decode to exactly 64 bytes.
 */
export function keypairFromBase58SecretKey(secretKeyBase58: string): Keypair {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(secretKeyBase58);
  } catch (err) {
    throw new Error(
      `invalid base58 secret key: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (decoded.length !== 64) {
    throw new Error(
      `expected 64-byte secret key (32-byte priv || 32-byte pub), got ${decoded.length} bytes`,
    );
  }
  return Keypair.fromSecretKey(decoded);
}

/**
 * Auto-detect whether `secret` is a base58 secret key (≈88 chars,
 * decodes to 64 bytes) or a BIP-39 mnemonic (whitespace-separated
 * words), and return the corresponding `Keypair`. This is what the
 * MCP session dispatcher calls.
 *
 * Detection rule:
 *   - Contains whitespace → mnemonic
 *   - Otherwise → try base58 decode
 *
 * Throws on anything that isn't recognizable as either shape.
 */
export function deriveKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  if (/\s/.test(trimmed)) {
    return deriveKeypairFromMnemonic(trimmed);
  }
  return keypairFromBase58SecretKey(trimmed);
}
