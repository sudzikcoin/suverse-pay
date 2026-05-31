import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

/**
 * Admin (ADMIN_EMAILS allowlist) must bypass per-user rate limits on:
 *   - POST /api/keys              (checkCreateKeyRateLimit cap + cooldown)
 *   - POST /api/keys/:id/probe    (in-memory 30/hour probe limiter)
 *
 * Non-admin users must continue to hit the limits — that's the
 * whole point of keeping them in place for everyone else.
 *
 * These tests mock @/lib/auth + the DB-touching helpers; the
 * admin allowlist itself runs unmocked against
 * process.env.ADMIN_EMAILS so we exercise the real isAdminEmail
 * lookup path that the routes import.
 */

const ADMIN_EMAIL = "admin@example.com";
const USER_EMAIL = "user@example.com";

interface AuthMock {
  mockResolvedValue: (v: unknown) => void;
}
async function getAuthMock(): Promise<Mock> {
  const mod = await import("../src/lib/auth");
  return mod.auth as unknown as Mock;
}

async function withFreshModules<T>(fn: () => Promise<T>): Promise<T> {
  vi.resetModules();
  // Re-set the mocks each run because vi.resetModules() clears them.
  vi.doMock("../src/lib/auth", () => ({ auth: vi.fn() }));
  vi.doMock("../src/lib/queries", async () => {
    const actual =
      await vi.importActual<typeof import("../src/lib/queries")>(
        "../src/lib/queries",
      );
    return {
      ...actual,
      checkCreateKeyRateLimit: vi.fn(),
      createResourceKey: vi.fn(),
      listLinkedKeysWithLabel: vi.fn(),
    };
  });
  vi.doMock("../src/lib/probe", () => ({
    probeResourceServer: vi.fn(),
  }));
  vi.doMock("../src/lib/seller-config", () => ({
    findOwnedResourceKey: vi.fn(),
    getConfig: vi.fn(),
  }));
  vi.doMock("../src/lib/db", () => ({
    dbQuery: vi.fn().mockResolvedValue([]),
  }));
  // Wipe the cached ADMIN_EMAILS set so each test's env wins.
  const admin = await import("../src/lib/admin");
  admin._resetAdminCacheForTests();
  return fn();
}

beforeEach(() => {
  delete process.env.ADMIN_EMAILS;
});

afterEach(() => {
  delete process.env.ADMIN_EMAILS;
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("POST /api/keys — admin rate-limit bypass", () => {
  it("admin email bypasses checkCreateKeyRateLimit and mints a key", async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    await withFreshModules(async () => {
      const auth = await getAuthMock();
      auth.mockResolvedValue({
        user: { id: "user-admin", email: ADMIN_EMAIL },
      });

      const queries = await import("../src/lib/queries");
      const checkRate = queries.checkCreateKeyRateLimit as unknown as Mock;
      const createKey = queries.createResourceKey as unknown as Mock;
      createKey.mockResolvedValue({
        resourceKeyId: "reskey_aaaaaaaa",
        plaintext: "sup_live_TESTKEY01TESTKEY02TESTKEY03TESTKEY04",
        label: "admin-test",
        createdAt: "2026-05-31T00:00:00.000Z",
      });

      const { POST } = await import("../src/app/api/keys/route");
      const req = new Request("http://localhost/api/keys", {
        method: "POST",
        body: JSON.stringify({ label: "admin-test" }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);

      expect(res.status).toBe(201);
      expect(checkRate).not.toHaveBeenCalled();
      expect(createKey).toHaveBeenCalledTimes(1);
    });
  });

  it("admin can mint many keys back-to-back without hitting the cap", async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    await withFreshModules(async () => {
      const auth = await getAuthMock();
      auth.mockResolvedValue({
        user: { id: "user-admin", email: ADMIN_EMAIL },
      });

      const queries = await import("../src/lib/queries");
      const checkRate = queries.checkCreateKeyRateLimit as unknown as Mock;
      const createKey = queries.createResourceKey as unknown as Mock;
      createKey.mockImplementation(async () => ({
        resourceKeyId: "reskey_aaaaaaaa",
        plaintext: "sup_live_TESTKEY01TESTKEY02TESTKEY03TESTKEY04",
        label: "x",
        createdAt: "2026-05-31T00:00:00.000Z",
      }));

      const { POST } = await import("../src/app/api/keys/route");
      for (let i = 0; i < 7; i++) {
        const req = new Request("http://localhost/api/keys", {
          method: "POST",
          body: JSON.stringify({ label: `admin-${i}` }),
          headers: { "content-type": "application/json" },
        });
        const res = await POST(req);
        expect(res.status).toBe(201);
      }
      expect(checkRate).not.toHaveBeenCalled();
      expect(createKey).toHaveBeenCalledTimes(7);
    });
  });

  it("non-admin still hits the cooldown lock", async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    await withFreshModules(async () => {
      const auth = await getAuthMock();
      auth.mockResolvedValue({
        user: { id: "user-civ", email: USER_EMAIL },
      });

      const queries = await import("../src/lib/queries");
      const checkRate = queries.checkCreateKeyRateLimit as unknown as Mock;
      const createKey = queries.createResourceKey as unknown as Mock;
      const cooldownEndsAt = new Date(Date.now() + 60_000).toISOString();
      checkRate.mockResolvedValue({
        ok: false,
        reason: "cooldown",
        activeKeys: 1,
        cooldownEndsAt,
      });

      const { POST } = await import("../src/app/api/keys/route");
      const req = new Request("http://localhost/api/keys", {
        method: "POST",
        body: JSON.stringify({ label: "user-test" }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);

      expect(res.status).toBe(429);
      expect(checkRate).toHaveBeenCalledWith("user-civ");
      expect(createKey).not.toHaveBeenCalled();
      const body = (await res.json()) as { reason: string };
      expect(body.reason).toBe("cooldown");
    });
  });

  it("non-admin still hits the max-keys cap", async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    await withFreshModules(async () => {
      const auth = await getAuthMock();
      auth.mockResolvedValue({
        user: { id: "user-civ", email: USER_EMAIL },
      });

      const queries = await import("../src/lib/queries");
      const checkRate = queries.checkCreateKeyRateLimit as unknown as Mock;
      checkRate.mockResolvedValue({
        ok: false,
        reason: "max-keys-reached",
        activeKeys: 5,
        cooldownEndsAt: null,
      });

      const { POST } = await import("../src/app/api/keys/route");
      const req = new Request("http://localhost/api/keys", {
        method: "POST",
        body: JSON.stringify({ label: "user-test" }),
        headers: { "content-type": "application/json" },
      });
      const res = await POST(req);

      expect(res.status).toBe(429);
      const body = (await res.json()) as { reason: string };
      expect(body.reason).toBe("max-keys-reached");
    });
  });
});

describe("POST /api/keys/:id/probe — admin rate-limit bypass", () => {
  // The probe limiter is in-memory and counts per userId. Mocking
  // the surrounding deps lets us drive enough requests to trip it
  // for a non-admin and assert that the admin path is untouched.

  it("admin bypasses the 30/hour probe limiter", async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    await withFreshModules(async () => {
      const auth = await getAuthMock();
      auth.mockResolvedValue({
        user: { id: "user-admin", email: ADMIN_EMAIL },
      });

      const sellerConfig = await import("../src/lib/seller-config");
      (sellerConfig.findOwnedResourceKey as unknown as Mock).mockResolvedValue(
        { resource_key_id: "reskey_aaaaaaaa" },
      );
      (sellerConfig.getConfig as unknown as Mock).mockResolvedValue({
        default_price_atomic: "1000",
        accepted_networks: ["eip155:8453"],
      });
      const probeMod = await import("../src/lib/probe");
      (probeMod.probeResourceServer as unknown as Mock).mockResolvedValue({
        ok: true,
        checks: [],
      });

      const { POST } = await import(
        "../src/app/api/keys/[id]/probe/route"
      );

      // 50 calls > limiter cap of 30; all must succeed for admin.
      for (let i = 0; i < 50; i++) {
        const req = new Request(
          "http://localhost/api/keys/reskey_aaaaaaaa/probe",
          {
            method: "POST",
            body: JSON.stringify({ url: "https://example.com/v1/x" }),
            headers: { "content-type": "application/json" },
          },
        );
        const res = await POST(req, {
          params: Promise.resolve({ id: "reskey_aaaaaaaa" }),
        });
        expect(res.status).toBe(200);
      }
      expect(probeMod.probeResourceServer).toHaveBeenCalledTimes(50);
    });
  });

  it("non-admin hits the 30/hour probe limiter after 30 probes", async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;

    await withFreshModules(async () => {
      const auth = await getAuthMock();
      auth.mockResolvedValue({
        user: { id: "user-civ-probe", email: USER_EMAIL },
      });

      const sellerConfig = await import("../src/lib/seller-config");
      (sellerConfig.findOwnedResourceKey as unknown as Mock).mockResolvedValue(
        { resource_key_id: "reskey_bbbbbbbb" },
      );
      (sellerConfig.getConfig as unknown as Mock).mockResolvedValue({
        default_price_atomic: "1000",
        accepted_networks: ["eip155:8453"],
      });
      const probeMod = await import("../src/lib/probe");
      (probeMod.probeResourceServer as unknown as Mock).mockResolvedValue({
        ok: true,
        checks: [],
      });

      const { POST } = await import(
        "../src/app/api/keys/[id]/probe/route"
      );

      let lastStatus = 0;
      for (let i = 0; i < 31; i++) {
        const req = new Request(
          "http://localhost/api/keys/reskey_bbbbbbbb/probe",
          {
            method: "POST",
            body: JSON.stringify({ url: "https://example.com/v1/x" }),
            headers: { "content-type": "application/json" },
          },
        );
        const res = await POST(req, {
          params: Promise.resolve({ id: "reskey_bbbbbbbb" }),
        });
        lastStatus = res.status;
      }
      // First 30 OK, 31st must be 429.
      expect(lastStatus).toBe(429);
    });
  });
});
