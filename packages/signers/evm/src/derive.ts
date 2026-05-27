import {
  mnemonicToAccount,
  privateKeyToAccount,
  type HDAccount,
  type PrivateKeyAccount,
} from "viem/accounts";

export type EvmAccount = HDAccount | PrivateKeyAccount;

const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

function detectShape(secret: string): "mnemonic" | "privateKey" {
  if (HEX_PRIVATE_KEY.test(secret)) return "privateKey";
  return "mnemonic";
}

function assertShape(secret: string): "mnemonic" | "privateKey" {
  const shape = detectShape(secret);
  if (shape === "privateKey") {
    if (!HEX_PRIVATE_KEY.test(secret)) {
      throw new Error("invalid private key: expected 0x-prefixed 32-byte hex");
    }
    return "privateKey";
  }
  const n = secret.trim().split(/\s+/).filter(Boolean).length;
  if (n !== 12 && n !== 24) {
    throw new Error(
      `invalid mnemonic: expected 12 or 24 BIP-39 words, got ${n}`,
    );
  }
  return "mnemonic";
}

/**
 * Derive a viem-compatible Account from a BIP-39 mnemonic OR a raw
 * 0x-prefixed hex private key. The Account holds `signTypedData`
 * which is what we call for EIP-712 signing.
 *
 * The address derived from a mnemonic uses Ethereum's canonical HD
 * path `m/44'/60'/0'/0/0` (viem's default).
 */
export function deriveEvmAccount(secret: string): EvmAccount {
  const shape = assertShape(secret);
  if (shape === "privateKey") {
    return privateKeyToAccount(secret as `0x${string}`);
  }
  return mnemonicToAccount(secret);
}
