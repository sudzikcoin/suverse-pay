/**
 * USDT and other Permit2-spendable ERC-20 token registry. Phase 4
 * Block 2 Sub-task 6.
 *
 * Unlike the EIP-3009 `domains.ts` table, this registry does NOT
 * carry an EIP-712 domain — Permit2 signs in its own domain
 * ("Permit2", chainId, Permit2 address) so the underlying token's
 * EIP-712 metadata is irrelevant for the signature. We only need to
 * know:
 *   1. The on-chain token address (so the signer can put it in
 *      TokenPermissions.token)
 *   2. The decimals (so the orchestrator/UI can format amounts)
 *   3. The display symbol (for logs / error messages)
 *
 * USDT addresses + metadata verified on-chain via `eth_call
 * name()/symbol()/decimals()` against each chain's public RPC on
 * 2026-05-29. Decimals are 6 across every entry EXCEPT BNB Chain
 * (Sub-task 7), where Binance-Peg USDC and Tether USDT both use
 * **18 decimals**. This is the canonical BSC stablecoin gotcha —
 * application code that assumes 6-decimal scaling will silently
 * under-charge by 12 orders of magnitude. The `decimals` field on
 * each entry is what authoritative; callers that format amounts
 * MUST read it, not hard-code.
 *
 * Naming variance observed on-chain (purely informational, not
 * used by the signer):
 *   - eip155:1   Ethereum:    name="Tether USD"  symbol="USDT"
 *   - eip155:10  Optimism:    name="Tether USD"  symbol="USDT"
 *   - eip155:137 Polygon:     name="USDT0"       symbol="USDT0"
 *   - eip155:8453 Base:       name="Tether USD"  symbol="USDT"
 *   - eip155:42161 Arbitrum:  name="USD₮0"       symbol="USD₮0"
 *   - eip155:42220 Celo:      name="Tether USD"  symbol="USD₮"
 *   - eip155:43114 Avalanche: name="TetherToken" symbol="USDt"
 *   - eip155:1329 Sei:        name="USDT.kava"   symbol="USDT"
 *   - eip155:59144 Linea:     name="Tether USD"  symbol="USDT"
 */

export interface Permit2TokenEntry {
  /** Human-readable symbol used in logs / errors only. */
  readonly symbol: string;
  /** Atomic-unit decimals. All current entries = 6 (USDT). */
  readonly decimals: number;
  readonly chainId: number;
  readonly address: `0x${string}`;
  /**
   * Whether this token natively supports EIP-3009 transferWithAuthorization.
   * USDT famously does NOT — that's why Permit2 is needed in the first
   * place. Recorded so dispatch code can avoid trying EIP-3009 first.
   */
  readonly hasEip3009: boolean;
  /**
   * Whether the token supports EIP-2612 Permit. Some USDT deployments
   * do (Avalanche, Polygon "USDT0", Sei "USDT.kava"); the canonical
   * Ethereum USDT does not. Used by the EIP-2612 gas-sponsoring
   * extension path (x402ExactPermit2Proxy.settleWithPermit).
   */
  readonly hasEip2612Permit: boolean;
}

type AddressKey = `0x${string}`;
type TokenKey = `${number}:${AddressKey}`;

function tokenKey(chainId: number, address: string): TokenKey {
  return `${chainId}:${address.toLowerCase() as AddressKey}`;
}

const USDT_TOKEN_TABLE: Record<TokenKey, Permit2TokenEntry> = (() => {
  const entries: Permit2TokenEntry[] = [
    {
      symbol: "USDT",
      decimals: 6,
      chainId: 1,
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      hasEip3009: false,
      hasEip2612Permit: false,
    },
    {
      symbol: "USDT",
      decimals: 6,
      chainId: 10,
      address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
      hasEip3009: false,
      hasEip2612Permit: false,
    },
    // ---- Sub-task 7: BNB Chain (Binance x402 adapter) ----
    // BSC stablecoins use 18 decimals, NOT 6 like every other entry
    // in this table. Verified 2026-05-29 via bsc-dataseed.binance.org
    // (decimals() returned 0x12 = 18 for both).
    //
    // Binance-Peg USD Coin — NOT a Circle-native deployment; on-chain
    // `version()` reverts, so the EIP-3009 path isn't available. The
    // Permit2 path through Binance's x402 facilitator is the route.
    {
      symbol: "USDC",
      decimals: 18,
      chainId: 56,
      address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      hasEip3009: false,
      hasEip2612Permit: false,
    },
    // Binance-Peg Tether USD — same shape as Ethereum USDT (no
    // EIP-3009, no EIP-2612 Permit), but 18 decimals.
    {
      symbol: "USDT",
      decimals: 18,
      chainId: 56,
      address: "0x55d398326f99059fF775485246999027B3197955",
      hasEip3009: false,
      hasEip2612Permit: false,
    },
    {
      // Polygon USDT migrated to the LayerZero v2 "USDT0" unified
      // bridge contract at this address. Per on-chain name(): "USDT0".
      symbol: "USDT0",
      decimals: 6,
      chainId: 137,
      address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      hasEip3009: false,
      hasEip2612Permit: true,
    },
    {
      // Coinbase-issued Tether USD on Base. Note this is NOT a Tether
      // foundation deployment; it's the Coinbase wrapper. Confirmed
      // by their bridge UX.
      symbol: "USDT",
      decimals: 6,
      chainId: 8453,
      address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      hasEip3009: false,
      hasEip2612Permit: false,
    },
    {
      symbol: "USD₮0",
      decimals: 6,
      chainId: 42161,
      address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      hasEip3009: false,
      hasEip2612Permit: true,
    },
    {
      symbol: "USD₮",
      decimals: 6,
      chainId: 42220,
      address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
      hasEip3009: false,
      hasEip2612Permit: false,
    },
    {
      // Avalanche's USDT supports EIP-2612 Permit — confirmed by
      // Tether's documentation.
      symbol: "USDt",
      decimals: 6,
      chainId: 43114,
      address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7",
      hasEip3009: false,
      hasEip2612Permit: true,
    },
    {
      // Sei "USDT.kava" — bridged via the Kava EVM channel.
      symbol: "USDT",
      decimals: 6,
      chainId: 1329,
      address: "0xB75D0B03c06A926e488e2659DF1A861F860bD3d1",
      hasEip3009: false,
      hasEip2612Permit: false,
    },
    {
      symbol: "USDT",
      decimals: 6,
      chainId: 59144,
      address: "0xA219439258ca9da29E9Cc4cE5596924745e12B93",
      hasEip3009: false,
      hasEip2612Permit: false,
    },
  ];
  const map: Record<TokenKey, Permit2TokenEntry> = {};
  for (const e of entries) {
    map[tokenKey(e.chainId, e.address)] = e;
  }
  return map;
})();

/** All chains where at least one Permit2-spendable token is registered. */
export const PERMIT2_TOKEN_CHAIN_IDS = Array.from(
  new Set(Object.values(USDT_TOKEN_TABLE).map((e) => e.chainId)),
).sort((a, b) => a - b);

/**
 * Returns the registered token entry for a (chainId, contract) pair,
 * or null if we have no record. Address comparison is case-insensitive.
 */
export function getPermit2Token(
  chainId: number,
  address: string,
): Permit2TokenEntry | null {
  return USDT_TOKEN_TABLE[tokenKey(chainId, address)] ?? null;
}

/**
 * Convenience: look up the USDT entry for a chain. Most chains have
 * exactly one USDT; if there are multiple wrappers in future, callers
 * must specify the address explicitly via `getPermit2Token`.
 */
export function getUsdtToken(chainId: number): Permit2TokenEntry | null {
  const matches = Object.values(USDT_TOKEN_TABLE).filter(
    (e) => e.chainId === chainId,
  );
  if (matches.length === 0) return null;
  // Today every chain has one entry — assert that to catch future
  // regressions where someone adds a second wrapper without updating
  // this lookup.
  if (matches.length > 1) {
    throw new Error(
      `multiple Permit2 token entries on chain ${chainId}; use getPermit2Token(chainId, address)`,
    );
  }
  return matches[0]!;
}

export function isPermit2Token(chainId: number, address: string): boolean {
  return USDT_TOKEN_TABLE[tokenKey(chainId, address)] !== undefined;
}

export function allPermit2Tokens(): Permit2TokenEntry[] {
  return Object.values(USDT_TOKEN_TABLE);
}
