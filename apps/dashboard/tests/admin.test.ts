import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetAdminCacheForTests, isAdminEmail } from "../src/lib/admin";

describe("isAdminEmail", () => {
  beforeEach(() => {
    _resetAdminCacheForTests();
  });
  afterEach(() => {
    delete process.env.ADMIN_EMAILS;
    _resetAdminCacheForTests();
  });

  it("returns false when ADMIN_EMAILS is unset", () => {
    expect(isAdminEmail("alice@example.com")).toBe(false);
  });

  it("returns false when ADMIN_EMAILS is empty string", () => {
    process.env.ADMIN_EMAILS = "";
    expect(isAdminEmail("alice@example.com")).toBe(false);
  });

  it("matches a single email exactly", () => {
    process.env.ADMIN_EMAILS = "alice@example.com";
    expect(isAdminEmail("alice@example.com")).toBe(true);
    expect(isAdminEmail("bob@example.com")).toBe(false);
  });

  it("matches comma-separated list with whitespace and case-insensitivity", () => {
    process.env.ADMIN_EMAILS = "  Alice@Example.com , bob@example.com ";
    expect(isAdminEmail("ALICE@example.com")).toBe(true);
    expect(isAdminEmail("bob@example.com")).toBe(true);
    expect(isAdminEmail("carol@example.com")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    process.env.ADMIN_EMAILS = "alice@example.com";
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail("")).toBe(false);
  });
});
