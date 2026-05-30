import type { Pool } from "pg";
import type { ProviderRegistry } from "@suverse-pay/orchestrator";
import { describe, expect, it } from "vitest";
import { buildSupportedResponse } from "./supported.js";

/**
 * Minimal ProviderRegistry stub. `buildSupportedResponse` uses only
 * `.enabled()` so the rest of the interface stays as `unknown` —
 * importing the real one drags pg-mem + a bunch of orchestrator
 * machinery this test file doesn't need.
 */
function fakeRegistry(enabledIds: ReadonlyArray<string>): ProviderRegistry {
  return {
    enabled: () => enabledIds.map((id) => ({ id })),
  } as unknown as ProviderRegistry;
}

/**
 * Minimal `pg.Pool` stub. We only consume `.query()` with a single
 * SQL+params shape from `supported.ts`. Returns a synthetic `rows`
 * array matching the columns the production code reads back.
 */
function fakePoolFromRows(
  rows: ReadonlyArray<{
    provider_id: string;
    network: string;
    scheme: string;
    extras_json: Record<string, unknown> | null;
  }>,
): Pool {
  return {
    query: async () => ({ rows, rowCount: rows.length }),
  } as unknown as Pool;
}

describe("buildSupportedResponse — without pool (backward compat)", () => {
  it("returns kinds-only shape with empty signers map", async () => {
    const reg = fakeRegistry(["cosmos-pay", "payai"]);
    const res = await buildSupportedResponse(reg);
    // Live adapters → at least the routes they cover are advertised.
    expect(res.kinds.length).toBeGreaterThan(0);
    // No pool → no extras on any kind.
    for (const k of res.kinds) {
      expect(k.extra).toBeUndefined();
    }
    expect(res.signers).toEqual({});
    expect(res.extensions).toEqual([]);
  });

  it("drops routes whose backing adapter is disabled", async () => {
    const reg = fakeRegistry([]); // nothing enabled
    const res = await buildSupportedResponse(reg);
    expect(res.kinds).toEqual([]);
  });
});

describe("buildSupportedResponse — with pool (PR-A extras flow)", () => {
  it("surfaces Solana feePayer from PayAI primary into the kind's extra", async () => {
    const reg = fakeRegistry(["coinbase-cdp", "payai"]);
    const pool = fakePoolFromRows([
      {
        provider_id: "payai",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        scheme: "exact",
        extras_json: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" },
      },
      // CDP is also enabled and is THE primary per ROUTING_CONFIG for
      // solana mainnet — but CDP has no extras row here. The
      // primary-walk should fall through to payai and pick its extras.
    ]);
    const res = await buildSupportedResponse(reg, pool);
    const solana = res.kinds.find(
      (k) => k.network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" && k.scheme === "exact",
    );
    expect(solana?.extra).toEqual({
      feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4",
    });
  });

  it("surfaces Cosmos grantee + chainId from cosmos-pay primary", async () => {
    const reg = fakeRegistry(["cosmos-pay"]);
    const pool = fakePoolFromRows([
      {
        provider_id: "cosmos-pay",
        network: "cosmos:noble-1",
        scheme: "exact_cosmos_authz",
        extras_json: {
          facilitator: "noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt",
          chainId: "noble-1",
          decimals: 6,
          symbol: "USDC",
        },
      },
    ]);
    const res = await buildSupportedResponse(reg, pool);
    const cosmos = res.kinds.find(
      (k) => k.network === "cosmos:noble-1" && k.scheme === "exact_cosmos_authz",
    );
    expect(cosmos?.extra).toEqual({
      facilitator: "noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt",
      chainId: "noble-1",
      decimals: 6,
      symbol: "USDC",
    });
  });

  it("aggregates signers map by CAIP-2 namespace", async () => {
    const reg = fakeRegistry(["cosmos-pay", "payai"]);
    const pool = fakePoolFromRows([
      {
        provider_id: "payai",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        scheme: "exact",
        extras_json: { feePayer: "PayAiFeePayerPubkey111111111111111111111111" },
      },
      {
        provider_id: "cosmos-pay",
        network: "cosmos:noble-1",
        scheme: "exact_cosmos_authz",
        extras_json: { facilitator: "noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt" },
      },
    ]);
    const res = await buildSupportedResponse(reg, pool);
    expect(res.signers).toEqual({
      "solana:*": ["PayAiFeePayerPubkey111111111111111111111111"],
      "cosmos:*": ["noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt"],
    });
    // EVM/TRON aren't sourced today; namespaces stay absent.
    expect(res.signers["eip155:*"]).toBeUndefined();
    expect(res.signers["tron:*"]).toBeUndefined();
  });

  it("omits kind.extra when no enabled-adapter row exists for that kind", async () => {
    const reg = fakeRegistry(["cosmos-pay"]);
    // No rows at all → every kind gets no extras.
    const pool = fakePoolFromRows([]);
    const res = await buildSupportedResponse(reg, pool);
    for (const k of res.kinds) {
      expect(k.extra).toBeUndefined();
    }
    expect(res.signers).toEqual({});
  });

  it("dedupes + sorts addresses in the signers map", async () => {
    const reg = fakeRegistry(["coinbase-cdp", "payai"]);
    // Solana mainnet's primary is coinbase-cdp; devnet's only adapter
    // is payai (per ROUTING_CONFIG). Two distinct primaries → two
    // distinct feePayers land in solana:*. Sorted ascending.
    const pool = fakePoolFromRows([
      {
        provider_id: "coinbase-cdp",
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        scheme: "exact",
        extras_json: { feePayer: "ZzzPubkey" },
      },
      {
        provider_id: "payai",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        scheme: "exact",
        extras_json: { feePayer: "AaaPubkey" },
      },
    ]);
    const res = await buildSupportedResponse(reg, pool);
    expect(res.signers["solana:*"]).toEqual(["AaaPubkey", "ZzzPubkey"]);
  });
});
