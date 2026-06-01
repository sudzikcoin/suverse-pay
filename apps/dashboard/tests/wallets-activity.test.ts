/**
 * Activity + summary helper tests. We mock the `./db` module so the
 * SQL strings are exercised against a synthetic in-memory dataset,
 * which is enough to catch wiring bugs (wrong filter, missing
 * sort) without spinning up Postgres.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// IMPORTANT: hoisted mock factory. vitest evaluates these BEFORE the
// imports below, so `rows` set later flows in via top-level closure.
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

describe("loadWalletActivity", () => {
  it("emits inbound + outbound x402 events for the wallet", async () => {
    const { loadWalletActivity } = await import("../src/lib/wallets-activity");
    const wallet = "base-merchant";
    const addr = "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0";
    const now = new Date();
    mockRows.batches.push([
      {
        id: "fp_1",
        created_at: now,
        direction: "inbound",
        payer: "0xpayer1",
        recipient: addr,
        gross_amount: "100000",
        tx_hash: "0xtxin",
        asset: "USDC",
        status: "settled",
      },
      {
        id: "fp_2",
        created_at: new Date(now.getTime() - 5000),
        direction: "outbound",
        payer: addr,
        recipient: "0xother",
        gross_amount: "50000",
        tx_hash: "0xtxout",
        asset: "USDC",
        status: "settled",
      },
    ]);
    const events = await loadWalletActivity(wallet, 7, 50);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("x402_in");
    expect(events[0].counterparty).toBe("0xpayer1");
    expect(events[1].kind).toBe("x402_out");
    expect(events[1].counterparty).toBe("0xother");
  });

  it("merges swap + refund events for swap-kind wallets", async () => {
    const { loadWalletActivity } = await import("../src/lib/wallets-activity");
    const now = new Date();
    // 3 batches: facilitator_payments, swap_transactions, swap_refunds
    mockRows.batches.push([]); // no fp rows
    mockRows.batches.push([
      {
        id: "11111111-1111-1111-1111-111111111111",
        created_at: new Date(now.getTime() - 3000),
        completed_at: new Date(now.getTime() - 1000),
        status: "completed",
        input_amount: "1100000",
        fee_amount: "11000",
        output_token: "0xWETH",
        swap_tx_hash: "0xswap1",
        error: null,
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        created_at: new Date(now.getTime() - 9000),
        completed_at: null,
        status: "failed_slippage",
        input_amount: "500000",
        fee_amount: "0",
        output_token: "0xAERO",
        swap_tx_hash: null,
        error: "delivered_0_lt_min_X",
      },
    ]);
    mockRows.batches.push([
      {
        id: "33333333-3333-3333-3333-333333333333",
        created_at: new Date(now.getTime() - 8000),
        buyer_address: "0xbuyer",
        amount: "500500",
        status: "pending",
        reason: "rpc_race",
        refund_tx_hash: null,
      },
    ]);
    const events = await loadWalletActivity("base-swap", 7, 10);
    expect(events.length).toBe(3);
    // Sorted newest-first by the event's occurredAt — for the
    // completed swap we use completed_at (most recent), for the
    // failed swap we fall back to created_at (oldest), refund sits
    // between them.
    expect(events[0].kind).toBe("swap_completed");
    expect(events[1].kind).toBe("refund_pending");
    expect(events[2].kind).toBe("swap_failed");
  });

  it("returns empty for unknown wallet ids", async () => {
    const { loadWalletActivity } = await import("../src/lib/wallets-activity");
    const events = await loadWalletActivity("does-not-exist", 7, 10);
    expect(events).toEqual([]);
  });
});

describe("loadFeesByPeriod", () => {
  it("buckets fees into today / week / month and pads to 30 days", async () => {
    const { loadFeesByPeriod } = await import("../src/lib/wallets-activity");
    const today = new Date().toISOString().slice(0, 10);
    mockRows.batches.push([
      { day: today, fees: "11000" }, // $0.011 today
      // a row 5 days ago, still within the 7d window
      {
        day: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10),
        fees: "22000",
      },
      // a row 20 days ago, only in 30d window
      {
        day: new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10),
        fees: "33000",
      },
    ]);
    const out = await loadFeesByPeriod();
    expect(out.todayAtomic).toBe("11000");
    expect(out.weekAtomic).toBe("33000"); // 11000 + 22000
    expect(out.monthAtomic).toBe("66000"); // 11000 + 22000 + 33000
    expect(out.daily).toHaveLength(30);
    // Series oldest-first.
    expect(out.daily[0].date < out.daily[29].date).toBe(true);
    // Today's entry is the LAST one.
    expect(out.daily[29].date).toBe(today);
    expect(out.daily[29].feeAtomic).toBe("11000");
  });

  it("returns zeros when there are no rows", async () => {
    const { loadFeesByPeriod } = await import("../src/lib/wallets-activity");
    mockRows.batches.push([]);
    const out = await loadFeesByPeriod();
    expect(out.todayAtomic).toBe("0");
    expect(out.weekAtomic).toBe("0");
    expect(out.monthAtomic).toBe("0");
    expect(out.daily.every((d) => d.feeAtomic === "0")).toBe(true);
  });
});

describe("loadPendingRefunds", () => {
  it("returns count and total atomic", async () => {
    const { loadPendingRefunds } = await import("../src/lib/wallets-activity");
    mockRows.batches.push([{ count: "3", total: "1611000" }]);
    const out = await loadPendingRefunds();
    expect(out.countRows).toBe(3);
    expect(out.totalAtomic).toBe("1611000");
  });
  it("handles the no-rows path with null total", async () => {
    const { loadPendingRefunds } = await import("../src/lib/wallets-activity");
    mockRows.batches.push([{ count: "0", total: null }]);
    const out = await loadPendingRefunds();
    expect(out.countRows).toBe(0);
    expect(out.totalAtomic).toBe("0");
  });
});

describe("loadTopActiveWallets", () => {
  it("returns top 5 ordered by event count desc", async () => {
    const { loadTopActiveWallets } = await import(
      "../src/lib/wallets-activity"
    );
    // One batch per wallet (7 wallets total in registry).
    const stub = (events: number, net: string) => [{
      events: String(events),
      net,
    }];
    mockRows.batches.push(stub(1, "100"));   // base-merchant
    mockRows.batches.push(stub(0, "0"));      // base-buyer
    mockRows.batches.push(stub(9, "900"));    // base-swap
    mockRows.batches.push(stub(4, "400"));    // solana-merchant
    mockRows.batches.push(stub(0, "0"));      // solana-service
    mockRows.batches.push(stub(2, "200"));    // solana-swap
    mockRows.batches.push(stub(0, "0"));      // cosmos-merchant
    const top = await loadTopActiveWallets();
    expect(top.length).toBe(5);
    // Most active wallet first
    expect(top[0].walletId).toBe("base-swap");
    expect(top[0].events24h).toBe(9);
    // The two zero-event wallets are pruned past the top-5 cut
    expect(top.map((t) => t.walletId)).toContain("base-merchant");
  });
});
