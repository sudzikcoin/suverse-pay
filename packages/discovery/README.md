# @suverse-pay/discovery

Aggregates paid x402 endpoint discovery across multiple catalogs into
a single normalized result shape. Built for the `discover_endpoints`
MCP tool in `apps/mcp` (wiring in Sub-task 5).

## What this does

```ts
import {
  aggregate,
  BazaarSource,
  CosmosCatalogSource,
} from "@suverse-pay/discovery";

const endpoints = await aggregate(
  [new BazaarSource(), new CosmosCatalogSource()],
  {
    query: "weather forecast",
    network: "eip155:8453",
    maxPriceUsd: "0.50",
    limit: 10,
  },
);
// endpoints: DiscoveredEndpoint[] — deduped, ranked, capped.
```

## Sources

### Bazaar (`bazaar`)

Coinbase's public discovery catalog at
`GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/search`.
No authentication required (per CDP docs, read-only catalog APIs do
not require API keys).

**Coverage limitation**: Bazaar indexes ONLY endpoints settled
through CDP Facilitator. Cosmos-native endpoints (via cosmos-pay) and
any future non-CDP facilitator's endpoints will NOT appear here. The
`cosmos-catalog` source exists to fill that gap.

Bazaar quality ranking is built into result ordering (not a separate
field) and is recomputed on a 6-hour schedule. Per-call `limit` is
hard-capped at 20 by Bazaar.

### Cosmos catalog (`cosmos-catalog`)

Phase 2 placeholder — returns `[]`. Structure is in place for Phase 3+
when Cosmos-native sellers start registering. Documented in
`src/sources/cosmos-catalog.ts`.

### Future Solana catalogs

Deferred to Phase 3 along with Solana signer work.

## Normalization contract

```ts
interface DiscoveredEndpoint {
  resource: string;             // URL of the paid endpoint
  description?: string;
  network: string;              // CAIP-2, e.g. "eip155:8453"
  asset: string;                // contract address or symbol
  scheme: string;               // "exact", "exact_cosmos_authz", ...
  amount: string;               // base units, decimal string
  estimatedPriceUsd?: string;   // best-effort for known stablecoins
  payTo: string;
  maxTimeoutSeconds?: number;
  sourceId: string;             // "bazaar" | "cosmos-catalog" | ...
  discoveredAt: string;         // ISO 8601, when we retrieved this
  metadata?: Record<string, unknown>;
}
```

A Bazaar `resource` with N `accepts[]` entries expands to N
`DiscoveredEndpoint`s — one per (network, asset, scheme) tuple. They
are operationally different payment options and the consumer needs to
see each.

## Dedup logic

Dedup key is the tuple `(resource, network, asset)`. Same resource
URL with different `(network, asset)` — e.g. USDC on Base AND EURC on
Polygon — is preserved as two separate entries. Collapsing by URL
alone would hide payment options.

When the same `(resource, network, asset)` shows up in multiple
sources, the **first source in registration order** wins. Bazaar is
registered first so its quality ranking comes through for any shared
option.

Asset comparison is case-insensitive (`0xABC` and `0xabc` are the
same asset).

## Ordering

After dedup, results are sorted:

1. **Price ascending** if `params.maxPriceUsd` was set (or
   `sortByPrice: true` was passed explicitly). Entries with a known
   `estimatedPriceUsd` rank before entries without.
2. **Source priority** — `bazaar` > `cosmos-catalog` > unknown.
3. **Recency** — newer `discoveredAt` first.

Then `limit` is applied (default 20, hard cap 100).

## Resilience

`aggregate()` uses `Promise.allSettled` — one source throwing or
timing out does NOT kill the whole call. Failed sources are logged
and skipped; surviving sources still return data.

Inside `BazaarSource`, every error path returns `[]` (never throws):

- HTTP 429: exponential backoff `[1s, 2s, 4s]` (configurable). If all
  three retries 429, return `[]`.
- HTTP 4xx/5xx (other): return `[]` + log.
- Network error (DNS, refused, etc.): return `[]` + log.
- Per-request timeout: 10s (configurable). Aborted requests return `[]`.
- Schema mismatch on response body: return `[]` + log first issues.

## Security

No secrets in this package. Bazaar is read-only public data.

The Bazaar response contains `payTo` addresses, `extra` fields with
EIP-712 domain hints (`name`, `version`), and `description`/`tags`.
None of this is trusted blindly by the signer — the EVM signer
(`@suverse-pay/signer-evm`) re-validates `extra.{name,version}` against
its local trusted domain table before signing. Discovery is a
candidate list, not an authority.

## Tests

```bash
pnpm --filter @suverse-pay/discovery test
```

32 tests:

- **Bazaar unit tests** (mocked HTTP): happy path, multiple-accepts
  expansion, stablecoin price estimation, query string forwarding,
  metadata passthrough, HTTP 5xx graceful degradation, 429 retry
  with backoff, 429 retries exhausted, network rejection, timeout
  abort, schema mismatch.
- **Cosmos catalog**: returns empty (placeholder).
- **Aggregator**: tuple dedup correctness — same `(resource,
  network, asset)` collapses, different `network` or different
  `asset` does NOT collapse. Case-insensitive asset comparison.
- **Aggregator resilience**: one source throwing does not fail the
  whole query; all-fail returns `[]`.
- **Aggregator ordering**: price ascending, priced-before-unpriced,
  source-priority tiebreaker, recency tiebreaker.
- **Aggregator limit**: default 20, max 100, explicit honored.
- **Real Bazaar integration test**: hits the real API once, caches
  response to `test-fixtures/bazaar-real-response.json` for rerun
  stability. To refresh, delete the fixture. If Bazaar is
  unreachable on first run, the test logs a warning and passes — the
  mocked tests are the correctness gate.
