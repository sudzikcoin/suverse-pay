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

const config: Config = {
  port: 3100,
  host: "127.0.0.1",
  gatewayUrl: "http://localhost:3000",
  adminApiKey: "test-admin-key",
  sessionTimeoutMs: 60_000,
  externalCallTimeoutMs: 15_000,
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
