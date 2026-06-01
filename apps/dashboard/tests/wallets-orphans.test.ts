import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletBalanceSnapshot } from "../src/lib/wallets-onchain";

const mockRows: { batches: unknown[][] } = { batches: [] };

vi.mock("../src/lib/db", () => ({
  dbQuery: vi.fn(async () => {
    return mockRows.batches.shift() ?? [];
  }),
}));

beforeEach(() => {
  mockRows.batches = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

function snap(
  walletId: string,
  network: WalletBalanceSnapshot["network"],
  extras: WalletBalanceSnapshot["extras"],
): WalletBalanceSnapshot {
  return {
    walletId,
    address: "0xstub",
    network,
    native: { symbol: "ETH", amountAtomic: "0", decimals: 18 },
    usdc: { symbol: "USDC", amountAtomic: "0", decimals: 6 },
    extras,
    errors: null,
  };
}

describe("detectOrphans", () => {
  it("flags a non-zero output_token whose most-recent row is failed_slippage", async () => {
    const { detectOrphans } = await import("../src/lib/wallets-orphans");
    const snapshot = snap("base-swap", "eip155:8453", [
      {
        symbol: "WETH…",
        amountAtomic: "548945379898203",
        decimals: 18,
        tokenIdentifier: "0x4200000000000000000000000000000000000006",
      },
    ]);
    mockRows.batches.push([
      { quote_id: "qb_orphan_001", status: "failed_slippage" },
    ]);
    const r = await detectOrphans([snapshot]);
    expect(r.countRows).toBe(1);
    expect(r.items[0].walletId).toBe("base-swap");
    expect(r.items[0].suspectQuoteId).toBe("qb_orphan_001");
    expect(r.items[0].suspectStatus).toBe("failed_slippage");
  });

  it("ignores zero balances", async () => {
    const { detectOrphans } = await import("../src/lib/wallets-orphans");
    const s = snap("base-swap", "eip155:8453", [
      {
        symbol: "WETH…",
        amountAtomic: "0",
        decimals: 18,
        tokenIdentifier: "0x4200000000000000000000000000000000000006",
      },
    ]);
    const r = await detectOrphans([s]);
    expect(r.countRows).toBe(0);
  });

  it("does NOT flag an in-flight swap (status=executing) — balance is legitimately mid-swap", async () => {
    const { detectOrphans } = await import("../src/lib/wallets-orphans");
    const s = snap("base-swap", "eip155:8453", [
      {
        symbol: "AERO…",
        amountAtomic: "12345",
        decimals: 18,
        tokenIdentifier: "0xAERO",
      },
    ]);
    mockRows.batches.push([{ quote_id: "qb_running", status: "executing" }]);
    const r = await detectOrphans([s]);
    expect(r.countRows).toBe(0);
  });

  it("flags non-swap wallets as never-orphan (merchant has no swap_transactions)", async () => {
    const { detectOrphans } = await import("../src/lib/wallets-orphans");
    const s = snap("base-merchant", "eip155:8453", [
      {
        symbol: "junk…",
        amountAtomic: "100",
        decimals: 18,
        tokenIdentifier: "0xjunk",
      },
    ]);
    const r = await detectOrphans([s]);
    expect(r.countRows).toBe(0);
  });

  it("walks multiple swap wallets and reports per-row", async () => {
    const { detectOrphans } = await import("../src/lib/wallets-orphans");
    const base = snap("base-swap", "eip155:8453", [
      {
        symbol: "WETH…",
        amountAtomic: "111",
        decimals: 18,
        tokenIdentifier: "0xWETH",
      },
      {
        symbol: "AERO…",
        amountAtomic: "222",
        decimals: 18,
        tokenIdentifier: "0xAERO",
      },
    ]);
    const sol = snap(
      "solana-swap",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      [
        {
          symbol: "BONK…",
          amountAtomic: "333",
          decimals: 6,
          tokenIdentifier: "BONKmint",
        },
      ],
    );
    mockRows.batches.push([{ quote_id: "qb_w1", status: "failed" }]);   // WETH
    mockRows.batches.push([{ quote_id: "qb_w2", status: "completed" }]); // AERO
    mockRows.batches.push([{ quote_id: "q_w3",  status: "failed_slippage" }]); // BONK
    const r = await detectOrphans([base, sol]);
    expect(r.countRows).toBe(3);
    expect(r.items.map((i) => i.walletId).sort()).toEqual([
      "base-swap",
      "base-swap",
      "solana-swap",
    ]);
  });
});
