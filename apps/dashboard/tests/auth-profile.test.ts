import { describe, expect, it } from "vitest";
import { extractProfile } from "../src/lib/auth-profile";

/**
 * Pins the mapping from raw OAuth profile objects → the column set
 * upsertDashboardUser writes. Profile shapes here are abbreviated
 * but the field names match what Google/GitHub actually return on
 * the userinfo response NextAuth surfaces in the signIn callback.
 */

describe("extractProfile — google", () => {
  it("captures email_verified + locale, leaves GitHub-only fields null", () => {
    const out = extractProfile("google", {
      sub: "1234",
      email: "user@example.com",
      email_verified: true,
      locale: "en",
      name: "Test User",
      picture: "https://example.com/p.png",
    });
    expect(out.emailVerified).toBe(true);
    expect(out.locale).toBe("en");
    expect(out.githubUsername).toBeNull();
    expect(out.profileUrl).toBeNull();
    expect(out.company).toBeNull();
    expect(out.bio).toBeNull();
    expect(out.location).toBeNull();
  });

  it("treats missing email_verified as null (unknown), not false", () => {
    const out = extractProfile("google", { sub: "1234", locale: "fr" });
    expect(out.emailVerified).toBeNull();
    expect(out.locale).toBe("fr");
  });

  it("treats empty locale string as null", () => {
    const out = extractProfile("google", { sub: "1234", locale: "" });
    expect(out.locale).toBeNull();
  });
});

describe("extractProfile — github", () => {
  it("captures login/html_url/company/bio/location, leaves Google-only null", () => {
    const out = extractProfile("github", {
      id: 99,
      login: "octocat",
      html_url: "https://github.com/octocat",
      company: "@anthropic",
      bio: "I build things",
      location: "SF",
      email: "octocat@example.com",
    });
    expect(out.githubUsername).toBe("octocat");
    expect(out.profileUrl).toBe("https://github.com/octocat");
    expect(out.company).toBe("@anthropic");
    expect(out.bio).toBe("I build things");
    expect(out.location).toBe("SF");
    expect(out.emailVerified).toBeNull();
    expect(out.locale).toBeNull();
  });

  it("nulls out empty strings + null/undefined fields cleanly", () => {
    const out = extractProfile("github", {
      id: 99,
      login: "octocat",
      html_url: "",
      company: null,
      bio: undefined,
    });
    expect(out.githubUsername).toBe("octocat");
    expect(out.profileUrl).toBeNull();
    expect(out.company).toBeNull();
    expect(out.bio).toBeNull();
    expect(out.location).toBeNull();
  });
});

describe("extractProfile — edge cases", () => {
  it("non-object profile returns all nulls", () => {
    const out = extractProfile("google", null);
    expect(out).toEqual({
      githubUsername: null,
      emailVerified: null,
      locale: null,
      profileUrl: null,
      company: null,
      bio: null,
      location: null,
    });
  });

  it("string profile returns all nulls (no throw)", () => {
    const out = extractProfile("github", "not-an-object");
    expect(out.githubUsername).toBeNull();
  });
});
