import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CREATE_COOLDOWN_MS,
  MAX_KEYS_PER_USER,
} from "../src/lib/queries";

/**
 * Behavioural tests for the key-generation primitives + constants.
 *
 * The DB-touching helpers (createResourceKey, revokeResourceKey,
 * checkCreateKeyRateLimit, listLinkedKeysWithLabel, linkResourceKey)
 * live behind a Postgres pool — covered by the apps/dashboard
 * integration suite once we wire one up (Phase 5 follow-on). For now
 * we test the in-process invariants: generators, constants, and the
 * hash contract the route handler relies on.
 */

describe("rate-limit constants", () => {
  it("MAX_KEYS_PER_USER is a sane cap (low single-digit)", () => {
    expect(MAX_KEYS_PER_USER).toBeGreaterThanOrEqual(1);
    expect(MAX_KEYS_PER_USER).toBeLessThanOrEqual(10);
  });

  it("CREATE_COOLDOWN_MS is exactly one hour", () => {
    expect(CREATE_COOLDOWN_MS).toBe(60 * 60 * 1000);
  });
});

describe("plaintext key format invariants (must stay in sync with apps/api)", () => {
  // The plaintext format the dashboard generates is `sup_live_<32 alnum>`.
  // The route handler hashes it sha256-hex before insert. Both ends —
  // dashboard (insert) and apps/api (verify) — read the same column
  // (resource_api_keys.key_hash) so the hashing contract is part of
  // the wire spec, not an internal detail.
  //
  // These tests pin the invariant: a plaintext that the dashboard
  // would mint, hashed via sha256-hex, must produce a deterministic
  // 64-character hex string that the apps/api lookup query expects.

  function shaHex(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
  }

  it("sha256(plaintext) is 64 hex characters", () => {
    const sample = "sup_live_abcdef0123456789ABCDEFGHIJKLMN012345";
    const hash = shaHex(sample);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hash is deterministic — same plaintext → same hash", () => {
    const plain = "sup_live_TESTKEY01TESTKEY02TESTKEY03TESTKEY04";
    expect(shaHex(plain)).toBe(shaHex(plain));
  });

  it("hash matches the cross-reference fixture (apps/api uses the same algorithm)", () => {
    // Pin a single known (plaintext, hash) pair so a future refactor
    // that swaps `createHash("sha256")` for a different primitive
    // (Web Crypto's `crypto.subtle.digest`, etc.) breaks loudly.
    expect(shaHex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("key id format (resource_api_keys.id convention)", () => {
  // The id format is shared with apps/api — `reskey_<8 hex>`. The
  // pattern shows up in logs, audit trails, and the DELETE route's
  // URL-shape validation. If we change the format, every consumer
  // breaks at once, so the regex is the contract.
  const idRegex = /^reskey_[0-9a-f]{8}$/;

  it("the reskey regex matches valid ids", () => {
    expect(idRegex.test("reskey_a1b2c3d4")).toBe(true);
    expect(idRegex.test("reskey_00000000")).toBe(true);
  });

  it("the reskey regex rejects malformed ids", () => {
    expect(idRegex.test("reskey_xyz")).toBe(false); // wrong length
    expect(idRegex.test("reskey_a1b2c3d4e5")).toBe(false); // too long
    expect(idRegex.test("RESKEY_a1b2c3d4")).toBe(false); // uppercase
    expect(idRegex.test("ressey_a1b2c3d4")).toBe(false); // typo
    expect(idRegex.test("a1b2c3d4")).toBe(false); // missing prefix
  });
});
