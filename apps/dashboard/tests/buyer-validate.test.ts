import { describe, expect, it } from "vitest";
import { validateAddress } from "../src/lib/buyer";

describe("validateAddress — evm", () => {
  it("accepts a checksummed 40-hex address", () => {
    const ok = validateAddress(
      "evm",
      "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e",
    );
    expect(ok.ok).toBe(true);
  });

  it("rejects short / non-hex / missing prefix", () => {
    expect(validateAddress("evm", "0xabc").ok).toBe(false);
    expect(validateAddress("evm", "A0Cf798816D4b9b9866b5330EEa46a18382f251e").ok).toBe(false);
    expect(validateAddress("evm", "0xZZZf798816D4b9b9866b5330EEa46a18382f251e").ok).toBe(false);
  });
});

describe("validateAddress — solana", () => {
  it("accepts a 44-char base58 pubkey", () => {
    const ok = validateAddress(
      "solana",
      "CBYMYxfMv9eyNNxQUYUm3MQy3LvJ3pZmRq38aZkBxRuM",
    );
    expect(ok.ok).toBe(true);
  });

  it("rejects forbidden chars (0/O/I/l) and too-short input", () => {
    expect(validateAddress("solana", "0bcdefghijklmnopqrstuvwxyz123456789").ok).toBe(false);
    expect(validateAddress("solana", "tooShort").ok).toBe(false);
  });
});

describe("validateAddress — cosmos noble", () => {
  it("accepts a noble1-prefixed bech32 address", () => {
    const ok = validateAddress(
      "cosmos",
      "noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt",
    );
    expect(ok.ok).toBe(true);
  });

  it("rejects non-noble prefix or short address", () => {
    expect(
      validateAddress(
        "cosmos",
        "cosmos18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt",
      ).ok,
    ).toBe(false);
    expect(validateAddress("cosmos", "noble1abc").ok).toBe(false);
  });
});

describe("validateAddress — tron", () => {
  it("accepts a T-prefixed 34-char base58 address", () => {
    const ok = validateAddress(
      "tron",
      "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8",
    );
    expect(ok.ok).toBe(true);
  });

  it("rejects wrong prefix / wrong length", () => {
    expect(
      validateAddress("tron", "ZJRabPrwbZy45sbavfcjinPJC18kjpRTv8").ok,
    ).toBe(false);
    expect(validateAddress("tron", "TJRab").ok).toBe(false);
  });
});
