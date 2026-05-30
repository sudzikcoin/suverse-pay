import { describe, expect, it } from "vitest";
import {
  decideAnonymousTier,
  decideAuthenticatedTier,
  logVerificationLink,
} from "../src/lib/catalog-moderation";

describe("decideAuthenticatedTier", () => {
  it("is verified+approved when the user owns the linked key", () => {
    expect(
      decideAuthenticatedTier({
        hasResourceKeyLink: true,
        userOwnsKey: true,
      }),
    ).toEqual({ isVerified: true, status: "approved" });
  });

  it("is pending when no resource key was linked", () => {
    expect(
      decideAuthenticatedTier({
        hasResourceKeyLink: false,
        userOwnsKey: false,
      }),
    ).toEqual({ isVerified: false, status: "pending" });
  });

  it("is pending when a key was linked but the user doesn't own it", () => {
    // Defence-in-depth: the route already validates ownership, but
    // if a future refactor breaks the check we still don't surface
    // an auto-verified listing for a key the user has no claim to.
    expect(
      decideAuthenticatedTier({
        hasResourceKeyLink: true,
        userOwnsKey: false,
      }),
    ).toEqual({ isVerified: false, status: "pending" });
  });
});

describe("decideAnonymousTier", () => {
  it("is always pending+unverified regardless of body", () => {
    expect(decideAnonymousTier()).toEqual({
      isVerified: false,
      status: "pending",
    });
  });
});

describe("logVerificationLink", () => {
  it("returns a URL pointing at the dashboard /catalog/verify page", () => {
    const url = logVerificationLink({
      baseUrl: "https://suverse-pay.suverse.io",
      token: "abc123",
      email: "anon@example.com",
    });
    expect(url).toBe(
      "https://suverse-pay.suverse.io/catalog/verify?token=abc123",
    );
  });

  it("trims a trailing slash on baseUrl", () => {
    const url = logVerificationLink({
      baseUrl: "http://localhost:3002/",
      token: "tkn",
      email: "x@y.z",
    });
    expect(url).toBe("http://localhost:3002/catalog/verify?token=tkn");
  });

  it("url-encodes the token", () => {
    const url = logVerificationLink({
      baseUrl: "http://localhost:3002",
      token: "needs encoding!",
      email: "x@y.z",
    });
    expect(url).toContain("token=needs%20encoding!");
  });
});
