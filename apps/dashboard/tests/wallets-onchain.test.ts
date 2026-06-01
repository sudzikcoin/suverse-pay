/**
 * Mock-fetch tests for `readWalletBalances`. We only need to prove
 * the per-chain plumbing decodes RPC responses correctly and that
 * a single failing leg does not collapse the whole snapshot.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWalletBalances } from "../src/lib/wallets-onchain";
import {
  SUVERSE_WALLETS,
  type SuverseWallet,
} from "../src/lib/suverse-wallets";

function mockRpc(handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; body: string | null }> = [];
  let idx = 0;
  const m = vi.fn(async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, body });
    const h = handlers[Math.min(idx, handlers.length - 1)];
    idx += 1;
    return h(url, init);
  });
  globalThis.fetch = m as unknown as typeof fetch;
  return { calls, mock: m };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readWalletBalances on Base", () => {
  it("decodes native ETH + USDC + one extra ERC20", async () => {
    const baseSwap = SUVERSE_WALLETS.find((w) => w.id === "base-swap") as SuverseWallet;
    // Call order on Base: native (eth_getBalance), USDC (eth_call balanceOf),
    // then extras in order. We can't assume call order across Promise.all
    // so route by method.
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.method === "eth_getBalance") {
        return json({ jsonrpc: "2.0", id: 1, result: "0x" + (1234n).toString(16) });
      }
      if (body.method === "eth_call") {
        const data = body.params[0].data as string;
        // balanceOf selector 0x70a08231 — return different values
        // per `to` so we can tell USDC apart from the extra.
        const to = (body.params[0].to as string).toLowerCase();
        if (to === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") {
          // USDC — 5,000,000 atomic ($5)
          return json({ jsonrpc: "2.0", id: 1, result: "0x" + (5_000_000n).toString(16) });
        }
        // extras token — 9999 atomic
        return json({ jsonrpc: "2.0", id: 1, result: "0x" + (9999n).toString(16) });
      }
      throw new Error(`unexpected method ${body.method}`);
    }) as unknown as typeof fetch;

    const snap = await readWalletBalances(baseSwap, [
      {
        symbol: "WETH",
        decimals: 18,
        tokenIdentifier: "0x4200000000000000000000000000000000000006",
      },
    ]);
    expect(snap.walletId).toBe("base-swap");
    expect(snap.native).toEqual({ symbol: "ETH", amountAtomic: "1234", decimals: 18 });
    expect(snap.usdc).toEqual({
      symbol: "USDC",
      amountAtomic: "5000000",
      decimals: 6,
      tokenIdentifier: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    });
    expect(snap.extras).toHaveLength(1);
    expect(snap.extras[0]).toEqual({
      symbol: "WETH",
      amountAtomic: "9999",
      decimals: 18,
      tokenIdentifier: "0x4200000000000000000000000000000000000006",
    });
    expect(snap.errors).toBeNull();
  });

  it("isolates a failing leg into errors[] and zeroes that field", async () => {
    const baseMerchant = SUVERSE_WALLETS.find((w) => w.id === "base-merchant") as SuverseWallet;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.method === "eth_getBalance") {
        return json({ jsonrpc: "2.0", id: 1, result: "0xdeadbeef" });
      }
      if (body.method === "eth_call") {
        // USDC RPC fails
        return json({ jsonrpc: "2.0", id: 1, error: { message: "rate limit hit" } });
      }
      throw new Error("unexpected");
    }) as unknown as typeof fetch;

    const snap = await readWalletBalances(baseMerchant);
    expect(snap.native.amountAtomic).toBe(BigInt("0xdeadbeef").toString());
    expect(snap.usdc.amountAtomic).toBe("0");
    expect(snap.errors).not.toBeNull();
    expect(snap.errors).toHaveProperty("USDC");
    expect(snap.errors!.USDC).toMatch(/rate limit/);
  });
});

describe("readWalletBalances on Solana", () => {
  it("decodes native SOL lamports + USDC ATA sum", async () => {
    const solSwap = SUVERSE_WALLETS.find((w) => w.id === "solana-swap") as SuverseWallet;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.method === "getBalance") {
        return json({ jsonrpc: "2.0", id: 1, result: { value: 12_345_678 } });
      }
      if (body.method === "getTokenAccountsByOwner") {
        return json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            value: [
              {
                account: {
                  data: { parsed: { info: { tokenAmount: { amount: "1500000" } } } },
                },
              },
              {
                account: {
                  data: { parsed: { info: { tokenAmount: { amount: "200000" } } } },
                },
              },
            ],
          },
        });
      }
      throw new Error(`unexpected ${body.method}`);
    }) as unknown as typeof fetch;
    const snap = await readWalletBalances(solSwap);
    expect(snap.native.symbol).toBe("SOL");
    expect(snap.native.amountAtomic).toBe("12345678");
    expect(snap.usdc.amountAtomic).toBe("1700000"); // 1.5 + 0.2 USDC summed
  });
});

describe("readWalletBalances on Noble (Cosmos)", () => {
  it("decodes uusdc + unoble + an extra denom from one LCD response", async () => {
    const cosmos = SUVERSE_WALLETS.find((w) => w.id === "cosmos-merchant") as SuverseWallet;
    globalThis.fetch = vi.fn(async () => {
      return json({
        balances: [
          { denom: "uusdc", amount: "42000000" },
          { denom: "unoble", amount: "1000000" },
          { denom: "ibc/extra", amount: "99" },
        ],
      });
    }) as unknown as typeof fetch;
    const snap = await readWalletBalances(cosmos, [
      { symbol: "IBC", decimals: 6, tokenIdentifier: "ibc/extra" },
    ]);
    expect(snap.native.symbol).toBe("NOBLE");
    expect(snap.native.amountAtomic).toBe("1000000");
    expect(snap.usdc.amountAtomic).toBe("42000000");
    expect(snap.extras).toHaveLength(1);
    expect(snap.extras[0].amountAtomic).toBe("99");
  });
});

describe("readWalletBalances quiets stable output ordering", () => {
  it("sorts extras by symbol", async () => {
    const cosmos = SUVERSE_WALLETS.find((w) => w.id === "cosmos-merchant") as SuverseWallet;
    globalThis.fetch = vi.fn(async () => {
      return json({
        balances: [
          { denom: "uusdc", amount: "1" },
          { denom: "unoble", amount: "1" },
          { denom: "zZz", amount: "1" },
          { denom: "aAa", amount: "1" },
        ],
      });
    }) as unknown as typeof fetch;
    const snap = await readWalletBalances(cosmos, [
      { symbol: "ZZZ", decimals: 6, tokenIdentifier: "zZz" },
      { symbol: "AAA", decimals: 6, tokenIdentifier: "aAa" },
    ]);
    expect(snap.extras.map((e) => e.symbol)).toEqual(["AAA", "ZZZ"]);
  });
});
