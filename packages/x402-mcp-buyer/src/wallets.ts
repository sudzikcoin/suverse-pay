/**
 * Build the SuverseClient wallet bundle from process env vars.
 *
 * Env vars used (all optional — only chains with creds get a signer):
 *   BASE_PRIVATE_KEY   — 0x-prefixed EVM private key (works across all
 *                        18 EVM mainnets the client supports, not just
 *                        Base; the name is a habit from the buyer
 *                        scripts in the suverse-pay tree).
 *   EVM_PRIVATE_KEY    — alias for BASE_PRIVATE_KEY, preferred for
 *                        new configs.
 *   SOLANA_KEYPAIR     — base58-encoded secret key (Phantom export).
 *   COSMOS_MNEMONIC    — 12 or 24-word BIP-39 mnemonic for Noble.
 *   TRON_PRIVATE_KEY   — 64-hex private key.
 *
 * Returns the wallet bundle PLUS a list of chains that were
 * successfully configured. The MCP surfaces this in error messages
 * when buy_and_call hits a chain the user has no signer for.
 */

import type { MultiChainWallets } from "@suverselabs/x402-client";

export interface BuiltWallets {
  wallets: MultiChainWallets;
  configured: ReadonlyArray<"evm" | "solana" | "cosmos" | "tron">;
}

export function buildWalletsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BuiltWallets {
  const wallets: Mutable<MultiChainWallets> = {};
  const configured: Array<"evm" | "solana" | "cosmos" | "tron"> = [];

  const evmKey = env.EVM_PRIVATE_KEY ?? env.BASE_PRIVATE_KEY;
  if (evmKey && evmKey.length > 0) {
    // The client's EvmWallet expects a 0x-prefixed hex string at the
    // type level. We don't sanity-check the hex shape here — the
    // signer raises a clear error if it's malformed.
    wallets.evm = (evmKey.startsWith("0x") ? evmKey : `0x${evmKey}`) as `0x${string}`;
    configured.push("evm");
  }

  if (env.SOLANA_KEYPAIR && env.SOLANA_KEYPAIR.length > 0) {
    wallets.solana = env.SOLANA_KEYPAIR;
    configured.push("solana");
  }

  if (env.COSMOS_MNEMONIC && env.COSMOS_MNEMONIC.length > 0) {
    wallets.cosmos = env.COSMOS_MNEMONIC;
    configured.push("cosmos");
  }

  if (env.TRON_PRIVATE_KEY && env.TRON_PRIVATE_KEY.length > 0) {
    wallets.tron = env.TRON_PRIVATE_KEY;
    configured.push("tron");
  }

  return { wallets, configured };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
