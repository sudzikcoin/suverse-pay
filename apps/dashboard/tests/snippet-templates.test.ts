import { describe, expect, it } from "vitest";
import {
  isFramework,
  renderSnippet,
  SUPPORTED_FRAMEWORKS,
} from "../src/lib/snippet-templates";
import type { ResourceServerConfig } from "../src/lib/seller-config";

const BASE_CONFIG: ResourceServerConfig = {
  resourceKeyId: "reskey_deadbeef",
  defaultPriceAtomic: "70000",
  acceptedNetworks: ["eip155:8453"],
  payToEvm: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
  payToSolana: null,
  payToCosmos: null,
  payToTron: null,
  description: "test endpoint",
  updatedAt: "2026-05-30T00:00:00Z",
};

const FULL_CONFIG: ResourceServerConfig = {
  resourceKeyId: "reskey_cafebabe",
  defaultPriceAtomic: "100000",
  acceptedNetworks: [
    "eip155:8453",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "cosmos:noble-1",
    "tron:mainnet",
  ],
  payToEvm: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
  payToSolana: "CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM",
  payToCosmos: "noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj",
  payToTron: "TMpNsK3Dj2ehBwQ9Hv5PeFZboynD7JX2is",
  description: null,
  updatedAt: "2026-05-30T00:00:00Z",
};

describe("renderSnippet — Express", () => {
  it("inlines the key id, facilitator URL, payTo and price", () => {
    const out = renderSnippet({
      framework: "express",
      keyId: "reskey_deadbeef",
      facilitatorUrl: "https://facilitator.suverse.io",
      config: BASE_CONFIG,
      timestamp: "2026-05-30",
    });
    expect(out.code).toContain("reskey_deadbeef");
    expect(out.code).toContain("https://facilitator.suverse.io");
    expect(out.code).toContain("0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0");
    expect(out.code).toContain('"100000"' === out.code ? '"100000"' : '"70000"');
    expect(out.envVars).toContain("SUVERSE_PAY_API_KEY=sup_live_<paste-yours-here>");
    expect(out.install).toContain("@suverselabs/x402-server");
    expect(out.middlewareStatus).toBe("published");
  });

  it("emits one payment block per accepted network", () => {
    const out = renderSnippet({
      framework: "express",
      keyId: "reskey_cafebabe",
      facilitatorUrl: "https://facilitator.suverse.io",
      config: FULL_CONFIG,
      timestamp: "2026-05-30",
    });
    // Each entry comments its label
    expect(out.code).toContain("// Base");
    expect(out.code).toContain("// Solana");
    expect(out.code).toContain("// Cosmos · Noble");
    expect(out.code).toContain("// TRON");
    expect(out.code).toContain(
      "CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM",
    );
    expect(out.code).toContain(
      "noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj",
    );
    expect(out.code).toContain("TMpNsK3Dj2ehBwQ9Hv5PeFZboynD7JX2is");
  });
});

describe("renderSnippet — Fastify", () => {
  it("uses Fastify preHandler registration shape", () => {
    const out = renderSnippet({
      framework: "fastify",
      keyId: "reskey_deadbeef",
      facilitatorUrl: "https://facilitator.suverse.io",
      config: BASE_CONFIG,
      timestamp: "2026-05-30",
    });
    expect(out.code).toContain("createFastifyPreHandler");
    expect(out.code).toContain("preHandler: x402");
    expect(out.middlewareStatus).toBe("published");
  });
});

describe("renderSnippet — FastAPI", () => {
  it("emits a manual Python implementation with placeholder status", () => {
    const out = renderSnippet({
      framework: "fastapi",
      keyId: "reskey_deadbeef",
      facilitatorUrl: "https://facilitator.suverse.io",
      config: BASE_CONFIG,
      timestamp: "2026-05-30",
    });
    expect(out.language).toBe("python");
    expect(out.middlewareStatus).toBe("placeholder");
    expect(out.code).toContain("from fastapi import FastAPI");
    expect(out.code).toContain("https://facilitator.suverse.io");
    expect(out.install).toContain("fastapi");
    expect(out.install).toContain("httpx");
  });
});

describe("renderSnippet — common invariants", () => {
  it("inlines `SUVERSE_PAY_API_KEY` env reference, NEVER the plaintext", () => {
    for (const fw of SUPPORTED_FRAMEWORKS) {
      const out = renderSnippet({
        framework: fw,
        keyId: "reskey_deadbeef",
        facilitatorUrl: "https://facilitator.suverse.io",
        config: BASE_CONFIG,
        timestamp: "2026-05-30",
      });
      expect(out.code).toContain("SUVERSE_PAY_API_KEY");
      // The plaintext is NEVER inlined — we don't store it.
      expect(out.code).not.toMatch(/sup_live_[A-Za-z0-9]{32}/);
    }
  });
});

describe("isFramework", () => {
  it("recognises supported names", () => {
    expect(isFramework("express")).toBe(true);
    expect(isFramework("fastify")).toBe(true);
    expect(isFramework("fastapi")).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isFramework("django")).toBe(false);
    expect(isFramework("")).toBe(false);
  });
});
