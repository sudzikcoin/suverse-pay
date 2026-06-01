/**
 * Shared Cosmos chain → public LCD endpoint mapping used by every
 * cosmos_* handler. We intentionally keep this list short: each row
 * is a chain we've smoke-tested and intend to keep online. Adding a
 * new chain takes one line here.
 *
 * The LCDs are public reads; no API key. Adapter contract still holds
 * (no business logic, just HTTP indirection).
 */

export interface CosmosChain {
  /** Slug accepted in the public input — case-insensitive. */
  slug: string;
  /** Bech32 prefix of native addresses ("cosmos", "noble", ...). */
  bech32Prefix: string;
  /** Bech32 prefix of validator-operator addresses (slug + "valoper"). */
  bech32ValoperPrefix: string;
  /** Chain ID — exposed in handler responses for clarity. */
  chainId: string;
  /** Cosmos SDK LCD base URL, no trailing slash. */
  lcd: string;
  /** Native staking denom — used by chain-info to compute bonded ratio. */
  stakingDenom: string;
}

export const COSMOS_CHAINS: Record<string, CosmosChain> = {
  cosmoshub: {
    slug: "cosmoshub",
    bech32Prefix: "cosmos",
    bech32ValoperPrefix: "cosmosvaloper",
    chainId: "cosmoshub-4",
    lcd: "https://cosmos-rest.publicnode.com",
    stakingDenom: "uatom",
  },
  noble: {
    slug: "noble",
    bech32Prefix: "noble",
    bech32ValoperPrefix: "noblevaloper",
    chainId: "noble-1",
    lcd: "https://noble-api.polkachu.com",
    stakingDenom: "ustake",
  },
  osmosis: {
    slug: "osmosis",
    bech32Prefix: "osmo",
    bech32ValoperPrefix: "osmovaloper",
    chainId: "osmosis-1",
    lcd: "https://osmosis-rest.publicnode.com",
    stakingDenom: "uosmo",
  },
  juno: {
    slug: "juno",
    bech32Prefix: "juno",
    bech32ValoperPrefix: "junovaloper",
    chainId: "juno-1",
    lcd: "https://juno-rest.publicnode.com",
    stakingDenom: "ujuno",
  },
  stride: {
    slug: "stride",
    bech32Prefix: "stride",
    bech32ValoperPrefix: "stridevaloper",
    chainId: "stride-1",
    lcd: "https://stride-rest.publicnode.com",
    stakingDenom: "ustrd",
  },
};

/** Resolve a chain slug → config; null if unknown. Slug match is case-insensitive. */
export function getCosmosChain(slug: unknown): CosmosChain | null {
  if (typeof slug !== "string") return null;
  return COSMOS_CHAINS[slug.toLowerCase()] ?? null;
}

/** Resolve a bech32 address → chain config; null if prefix unrecognized. */
export function chainFromAddress(addr: string): CosmosChain | null {
  for (const c of Object.values(COSMOS_CHAINS)) {
    if (addr.startsWith(`${c.bech32Prefix}1`)) return c;
  }
  return null;
}
