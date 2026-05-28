import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../session.js";
import { handleInitSession } from "./init-session.js";
import type { Config } from "../config.js";

// Canonical BIP-39 test mnemonic (publicly known, never used for real funds).
const TEST_MNEMONIC_12 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Random hex private key fixture — not associated with any real wallet.
const TEST_PRIVATE_KEY =
  "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

// CAIP-2 network identifiers (mirrored locally to keep this test
// independent of signer-solana's export surface, but pinned to the
// exact values signer-solana accepts).
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
// Solana address derived from TEST_MNEMONIC_12 at m/44'/501'/0'/0' — pinned
// from packages/signers/solana/src/sign.test.ts so any drift in the
// HD-derivation chain (bip39/ed25519-hd-key/@solana/web3.js) surfaces
// immediately. Base58, 32-44 chars.
const TEST_SOLANA_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";

const config: Config = {
  port: 3100,
  host: "127.0.0.1",
  gatewayUrl: "http://localhost:3000",
  adminApiKey: "test-admin-key",
  sessionTimeoutMs: 60_000,
  externalCallTimeoutMs: 15_000,
  solanaRpcUrlMainnet: "https://api.mainnet-beta.solana.com",
  solanaRpcUrlDevnet: "https://api.devnet.solana.com",
};

describe("init_session", () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore();
  });
  afterEach(() => {
    store.destroyAll();
  });

  it("rejects a too-short mnemonic", async () => {
    const result = await handleInitSession(
      { secret: "one two three", networks: ["eip155:8453"] },
      { store, config },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_secret");
      expect(result.error.message).toMatch(/12 or 24/);
      expect(result.error.message).not.toContain("one two three");
    }
    expect(store.size()).toBe(0);
  });

  it("rejects a non-hex private key disguised as hex", async () => {
    const result = await handleInitSession(
      { secret: "0xZZZZ", networks: ["eip155:8453"] },
      { store, config },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_secret");
  });

  it("rejects unsupported networks listed", async () => {
    const result = await handleInitSession(
      { secret: TEST_MNEMONIC_12, networks: ["cosmos:noble-1"] },
      { store, config },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unsupported_network");
      expect(result.error.message).toContain("cosmos:noble-1");
      expect(result.error.message).toContain("cosmos:grand-1");
    }
    expect(store.size()).toBe(0);
  });

  it("derives addresses for cosmos:grand-1 and eip155:8453 from a 12-word mnemonic", async () => {
    const result = await handleInitSession(
      {
        secret: TEST_MNEMONIC_12,
        networks: ["cosmos:grand-1", "eip155:8453"],
      },
      { store, config },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.result.addresses["cosmos:grand-1"]).toMatch(/^noble1[a-z0-9]{38,58}$/);
    expect(result.result.addresses["eip155:8453"]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(store.size()).toBe(1);
  });

  it("rejects a private key for a cosmos network (mnemonic-only)", async () => {
    const result = await handleInitSession(
      { secret: TEST_PRIVATE_KEY, networks: ["cosmos:grand-1"] },
      { store, config },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("derivation_failed");
  });

  it("derives an EVM address from a raw private key for EVM networks", async () => {
    const result = await handleInitSession(
      { secret: TEST_PRIVATE_KEY, networks: ["eip155:8453", "eip155:137"] },
      { store, config },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.addresses["eip155:8453"]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Both EVM networks share the same account.
    expect(result.result.addresses["eip155:8453"]).toBe(result.result.addresses["eip155:137"]);
  });

  it("creates independent sessions for the same secret", async () => {
    const a = await handleInitSession(
      { secret: TEST_MNEMONIC_12, networks: ["eip155:8453"] },
      { store, config },
    );
    const b = await handleInitSession(
      { secret: TEST_MNEMONIC_12, networks: ["eip155:8453"] },
      { store, config },
    );
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.result.sessionId).not.toBe(b.result.sessionId);
      // Same secret → same derived address.
      expect(a.result.addresses["eip155:8453"]).toBe(b.result.addresses["eip155:8453"]);
    }
    expect(store.size()).toBe(2);
  });

  it("derives a Solana address for solana:5eykt... (mainnet) from a 12-word mnemonic", async () => {
    const result = await handleInitSession(
      { secret: TEST_MNEMONIC_12, networks: [SOLANA_MAINNET] },
      { store, config },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.addresses[SOLANA_MAINNET]).toBe(TEST_SOLANA_ADDRESS);
    // Base58 sanity check: alphanumeric, no 0/O/I/l, length 32-44.
    expect(result.result.addresses[SOLANA_MAINNET]).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("derives the same Solana address for devnet (same keypair across networks)", async () => {
    const result = await handleInitSession(
      { secret: TEST_MNEMONIC_12, networks: [SOLANA_DEVNET] },
      { store, config },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.addresses[SOLANA_DEVNET]).toBe(TEST_SOLANA_ADDRESS);
  });

  it("derives Cosmos + EVM + Solana addresses in a single mixed-network session", async () => {
    const result = await handleInitSession(
      {
        secret: TEST_MNEMONIC_12,
        networks: ["cosmos:grand-1", "eip155:8453", SOLANA_MAINNET],
      },
      { store, config },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.addresses["cosmos:grand-1"]).toMatch(/^noble1[a-z0-9]{38,58}$/);
    expect(result.result.addresses["eip155:8453"]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.result.addresses[SOLANA_MAINNET]).toBe(TEST_SOLANA_ADDRESS);
  });

  it("rejects an unsupported solana:<foo> network identifier", async () => {
    const result = await handleInitSession(
      { secret: TEST_MNEMONIC_12, networks: ["solana:foo"] },
      { store, config },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unsupported_network");
      expect(result.error.message).toContain("solana:foo");
    }
    expect(store.size()).toBe(0);
  });

  it("rejects a raw 0x-hex private key for a Solana network", async () => {
    const result = await handleInitSession(
      { secret: TEST_PRIVATE_KEY, networks: [SOLANA_MAINNET] },
      { store, config },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("derivation_failed");
      expect(result.error.message).toMatch(/solana networks require/i);
    }
  });

  it("error messages never echo back any portion of the secret", async () => {
    const inputs = [
      { secret: "0xZZZZ", networks: ["eip155:8453"] },
      { secret: "short", networks: ["eip155:8453"] },
      { secret: TEST_MNEMONIC_12, networks: ["cosmos:noble-1"] },
    ];
    for (const input of inputs) {
      const result = await handleInitSession(input, { store, config });
      if (result.ok) continue;
      // The first three or last three characters of the secret must not appear
      // in the error message.
      const sample = input.secret.slice(0, 6);
      expect(result.error.message).not.toContain(sample);
    }
  });
});
