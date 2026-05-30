/**
 * Cosmos network registry for the buyer SDK.
 *
 * The buyer-side scope is limited to chains we have an end-to-end
 * production verification trail for. v0.1.0 ships:
 *
 *   - `cosmos:noble-1` — Noble mainnet (USDC native `uusdc`). First
 *     real production paid call settled here 2026-05-30 (tx
 *     `5A0D8E2A…`, `F11FE419…`); see the suverse-pay project memory.
 *   - `cosmos:grand-1` — Noble testnet. Retained for development
 *     and Phase 4 smoke; deliberately included so dev workflows can
 *     point at the same code path without a code change.
 *
 * Adding another Cosmos chain means: (1) registering it here with
 * the chain-id + bech32 prefix + native asset denom, (2) confirming
 * the suverse-pay facilitator routes `exact_cosmos_authz` for that
 * chain in `services/facilitator/src/routing-config.ts`, (3) the
 * payer having an on-chain `MsgGrant{SendAuthorization}` to the
 * facilitator grantee before any payment can settle.
 */

export const COSMOS_NOBLE_MAINNET = "cosmos:noble-1";
export const COSMOS_NOBLE_TESTNET = "cosmos:grand-1";

export interface CosmosNetwork {
  /** CAIP-2 id as it appears in the seller's 402 challenge. */
  readonly caip2: string;
  /** Chain-id portion (e.g. "noble-1"). */
  readonly chainId: string;
  /** Bech32 prefix for addresses on this chain (e.g. "noble"). */
  readonly bech32Prefix: string;
  /** Native USDC denom — informational; not enforced. */
  readonly nativeAsset: string;
  /** Decimals for the native asset. USDC on Noble = 6. */
  readonly decimals: number;
  /** Default public REST API (Polkachu pattern). */
  readonly defaultRestApi: string;
  readonly testnet: boolean;
}

export const COSMOS_NETWORKS: readonly CosmosNetwork[] = [
  {
    caip2: COSMOS_NOBLE_MAINNET,
    chainId: "noble-1",
    bech32Prefix: "noble",
    nativeAsset: "uusdc",
    decimals: 6,
    defaultRestApi: "https://noble-api.polkachu.com",
    testnet: false,
  },
  {
    caip2: COSMOS_NOBLE_TESTNET,
    chainId: "grand-1",
    bech32Prefix: "noble",
    nativeAsset: "uusdc",
    decimals: 6,
    defaultRestApi: "https://noble-testnet-api.polkachu.com",
    testnet: true,
  },
];

const BY_CAIP2: ReadonlyMap<string, CosmosNetwork> = new Map(
  COSMOS_NETWORKS.map((n) => [n.caip2, n] as const),
);

export function lookupCosmosNetwork(caip2: string): CosmosNetwork | undefined {
  return BY_CAIP2.get(caip2);
}

export function isSupportedCosmosNetwork(caip2: string): boolean {
  return BY_CAIP2.has(caip2);
}
