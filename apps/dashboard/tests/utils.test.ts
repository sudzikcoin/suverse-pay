import { describe, expect, it } from "vitest";
import {
  explorerUrl,
  formatCount,
  formatPercent,
  formatRelativeTime,
  formatUsd,
  networkLabel,
  truncateMiddle,
} from "../src/lib/utils";

describe("formatUsd", () => {
  it("formats 6-decimal canonical USDC", () => {
    expect(formatUsd("1000000", 6)).toBe("$1.00");
    expect(formatUsd("1234567", 6)).toBe("$1.2345");
    expect(formatUsd("123450000", 6)).toBe("$123.45");
  });

  it("handles zero and empty", () => {
    expect(formatUsd("0", 6)).toBe("$0.00");
    expect(formatUsd("", 6)).toBe("$0.00");
  });

  it("inserts thousands separators for large amounts", () => {
    expect(formatUsd("1500000000000", 6)).toBe("$1,500,000.00");
  });

  it("preserves precision on uint256-sized values (no Number coercion)", () => {
    // $1B in 18-decimal precision — would overflow a JS Number.
    const val = (10n ** 27n).toString();
    expect(formatUsd(val, 18)).toBe("$1,000,000,000.00");
  });

  it("handles 18-decimal BSC / Tempo stablecoins (1 USDT-on-BSC = 1e18)", () => {
    expect(formatUsd("1000000000000000000", 18)).toBe("$1.00");
  });

  it("shows extra decimals when the value would round to zero at 2dp", () => {
    expect(formatUsd("100", 6)).toBe("$0.0001"); // 0.0001 USDC
  });
});

describe("formatCount", () => {
  it("inserts thousands separators", () => {
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1234567)).toBe("1,234,567");
  });
});

describe("formatPercent", () => {
  it("formats ratios as percent with 1 decimal", () => {
    expect(formatPercent(0.973)).toBe("97.3%");
    expect(formatPercent(1)).toBe("100.0%");
    expect(formatPercent(0)).toBe("0.0%");
  });

  it("returns em-dash for non-finite (NaN, Infinity)", () => {
    expect(formatPercent(NaN)).toBe("—");
    expect(formatPercent(Infinity)).toBe("—");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-05-29T12:00:00Z");

  it('"just now" for < 1 minute', () => {
    expect(formatRelativeTime(new Date("2026-05-29T11:59:30Z"), now)).toBe("just now");
  });

  it("minutes ago", () => {
    expect(formatRelativeTime(new Date("2026-05-29T11:55:00Z"), now)).toBe("5 min ago");
  });

  it("hours ago", () => {
    expect(formatRelativeTime(new Date("2026-05-29T09:00:00Z"), now)).toBe("3 hr ago");
  });

  it("absolute date once older than 24h", () => {
    const r = formatRelativeTime(new Date("2026-05-27T12:00:00Z"), now);
    expect(r).toMatch(/May (27|26)/);
  });
});

describe("explorerUrl", () => {
  it("returns the right explorer per chain", () => {
    expect(explorerUrl("eip155:1", "0xabc")).toBe("https://etherscan.io/tx/0xabc");
    expect(explorerUrl("eip155:8453", "0xabc")).toBe("https://basescan.org/tx/0xabc");
    expect(explorerUrl("eip155:56", "0xabc")).toBe("https://bscscan.com/tx/0xabc");
    expect(explorerUrl("tron:mainnet", "fff")).toBe("https://tronscan.org/#/transaction/fff");
    expect(explorerUrl("cosmos:noble-1", "AAA")).toBe(
      "https://www.mintscan.io/noble/transactions/AAA",
    );
    expect(explorerUrl("eip155:4217", "0xtx")).toBe("https://explore.tempo.xyz/tx/0xtx");
  });

  it("returns null for unknown chains (caller should render hash plain)", () => {
    expect(explorerUrl("eip155:999999", "0x")).toBeNull();
    expect(explorerUrl("ton:mainnet", "abc")).toBeNull();
  });
});

describe("networkLabel", () => {
  it("renders friendly labels for known networks", () => {
    expect(networkLabel("eip155:8453")).toBe("Base");
    expect(networkLabel("eip155:1")).toBe("Ethereum");
    expect(networkLabel("eip155:4217")).toBe("Tempo");
    expect(networkLabel("cosmos:noble-1")).toBe("Noble");
    expect(networkLabel("tron:mainnet")).toBe("TRON");
  });

  it("falls through to the raw identifier on unknowns", () => {
    expect(networkLabel("eip155:999999")).toBe("eip155:999999");
    expect(networkLabel("aptos:1")).toBe("aptos:1");
  });
});

describe("truncateMiddle", () => {
  it("preserves short strings unchanged", () => {
    expect(truncateMiddle("0xabcd1234")).toBe("0xabcd1234");
  });

  it("middle-elides long strings", () => {
    const hash = "0x618913f76b23878b2d0db3cba83c9073f45371ff790e972c240f5771bc74abfd";
    expect(truncateMiddle(hash, 8, 6)).toBe("0x618913…74abfd");
  });
});
