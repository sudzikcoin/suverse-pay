import { describe, expect, it } from "vitest";
import {
  classifyX402Challenge,
  makeSsrfGuard,
  parseLivenessBody,
  x402LivenessCheck,
  x402LivenessCheckPreflight,
  x402LivenessCheckValidator,
  type SsrfLookupFn,
} from "../src/handlers/x402-liveness-check.js";

// ─────────────────────────────────────────────────────────────────────
// Helpers — zero real network / DNS anywhere in this file
// ─────────────────────────────────────────────────────────────────────

const PUBLIC_URL = "https://api.example.com/v1/data/thing";

function buf(v: unknown): Buffer {
  return Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8");
}

function validChallenge(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        payTo: "0x1111111111111111111111111111111111111111",
        maxAmountRequired: "100000",
      },
      {
        scheme: "exact",
        network: "solana",
        payTo: "26edvkZ99Lfs6LEwfSbfbJG17NM6z4BqrWMk7Z8hTe4D",
        amount: "50000",
      },
    ],
    extensions: { bazaar: { info: { input: { type: "http" } } } },
    input_schema: { method: "POST" },
    ...overrides,
  };
}

/** fetch stub that records the call and returns a canned Response. */
function stubFetch(
  make: () => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return make();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function response(
  status: number,
  body: string | null,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

const publicLookup: SsrfLookupFn = async () => [
  { address: "93.184.216.34", family: 4 },
];

// ─────────────────────────────────────────────────────────────────────
// Validator — discovery-vs-422 split
// ─────────────────────────────────────────────────────────────────────

describe("x402LivenessCheckValidator", () => {
  it("no body → discovery-ok (null): the 402 challenge is served", () => {
    expect(x402LivenessCheckValidator(null, "POST")).toBeNull();
    expect(x402LivenessCheckValidator(Buffer.alloc(0), "POST")).toBeNull();
    expect(x402LivenessCheckValidator(buf("   "), "POST")).toBeNull();
  });

  it("missing / placeholder resource_url → discovery-ok (null)", () => {
    expect(x402LivenessCheckValidator(buf({}), "POST")).toBeNull();
    expect(
      x402LivenessCheckValidator(buf({ resource_url: "string" }), "POST"),
    ).toBeNull();
    expect(
      x402LivenessCheckValidator(buf({ resource_url: "<url>" }), "POST"),
    ).toBeNull();
  });

  it('present-but-invalid: "not a url" → 422 with error + input_schema', () => {
    const r = x402LivenessCheckValidator(buf({ resource_url: "not a url" }), "POST");
    expect(r?.status).toBe(422);
    const body = r?.body as Record<string, unknown>;
    expect(body["error"]).toBe("invalid_resource_url");
    expect(body["input_schema"]).toBeDefined();
  });

  it("non-http(s) scheme (ftp://x) → 422", () => {
    const r = x402LivenessCheckValidator(buf({ resource_url: "ftp://x" }), "POST");
    expect(r?.status).toBe(422);
    expect((r?.body as Record<string, unknown>)["error"]).toBe(
      "invalid_resource_url",
    );
  });

  it('method "DELETE" → 422 invalid_method', () => {
    const r = x402LivenessCheckValidator(
      buf({ resource_url: PUBLIC_URL, method: "DELETE" }),
      "POST",
    );
    expect(r?.status).toBe(422);
    const body = r?.body as Record<string, unknown>;
    expect(body["error"]).toBe("invalid_method");
    expect(body["input_schema"]).toBeDefined();
  });

  it("array request_body → 422; unparseable JSON → 400", () => {
    const bad = x402LivenessCheckValidator(
      buf({ resource_url: PUBLIC_URL, request_body: [1, 2] }),
      "POST",
    );
    expect(bad?.status).toBe(422);
    expect(x402LivenessCheckValidator(buf("{nope"), "POST")?.status).toBe(400);
  });

  it("valid body passes (lowercase method normalized)", () => {
    expect(
      x402LivenessCheckValidator(
        buf({ resource_url: PUBLIC_URL, method: "post", request_body: { a: 1 } }),
        "POST",
      ),
    ).toBeNull();
    const p = parseLivenessBody(
      buf({ resource_url: PUBLIC_URL, method: "post" }),
    );
    expect(p).toMatchObject({ kind: "ok", method: "POST" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// SSRF guard
// ─────────────────────────────────────────────────────────────────────

describe("makeSsrfGuard", () => {
  const guard = makeSsrfGuard(publicLookup);

  it.each([
    ["http://127.0.0.1:3003/health", /loopback/],
    ["http://10.1.2.3/", /private_10/],
    ["http://172.16.9.1/", /private_172\.16/],
    ["http://192.168.1.5/", /private_192\.168/],
    ["http://169.254.169.254/latest/meta-data/", /link_local_169\.254/],
    ["http://100.64.0.1/", /cgnat/],
    ["http://0.0.0.0/", /unspecified/],
    ["http://224.0.0.1/", /multicast/],
    ["http://[::1]/", /loopback_v6/],
    ["http://[::]/", /unspecified_v6/],
    ["http://[fe80::1]/", /link_local_fe80/],
    ["http://[fd00::2]/", /unique_local_fc00/],
    ["http://[::ffff:127.0.0.1]/", /loopback/],
    ["http://[::ffff:7f00:1]/", /loopback/], // hex-form v4-mapped
    ["http://[64:ff9b::a00:0001]/", /nat64/],
    ["http://user:pass@example.com/", /credentials_in_url/],
    ["ftp://x/", /non_http_scheme/],
    ["http://localhost:8080/", /localhost_hostname/],
    ["http://foo.localhost/", /localhost_hostname/],
  ])("blocks %s", async (url, reasonRe) => {
    const v = await guard(url);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(reasonRe);
  });

  it("blocks a hostname that RESOLVES to 192.168.1.1 (stubbed DNS)", async () => {
    const g = makeSsrfGuard(async () => [{ address: "192.168.1.1", family: 4 }]);
    const v = await g("https://evil-rebind.example.com/x");
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/resolves_to_blocked.*192\.168/);
  });

  it("blocks when ANY resolved address is private (multi-A)", async () => {
    const g = makeSsrfGuard(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ]);
    expect((await g("https://half-evil.example.com/")).allowed).toBe(false);
  });

  it("allows a public hostname (stub) and a public literal IP", async () => {
    expect((await guard("https://api.example.com/v1")).allowed).toBe(true);
    expect((await guard("https://93.184.216.34/x")).allowed).toBe(true);
  });

  it("DNS FAILURE does not block — DEAD verdict is the paid answer", async () => {
    const g = makeSsrfGuard(async () => {
      throw new Error("ENOTFOUND");
    });
    expect((await g("https://no-such-host.example.com/")).allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Preflight — pre-settle, {proceed:false} → no charge
// ─────────────────────────────────────────────────────────────────────

describe("x402LivenessCheckPreflight", () => {
  it("literal private target → proceed:false 422 blocked_target (no charge, no DNS)", async () => {
    const r = await x402LivenessCheckPreflight({
      body: buf({ resource_url: "http://127.0.0.1:3003/v1" }),
      method: "POST",
    });
    expect(r.proceed).toBe(false);
    if (!r.proceed) {
      expect(r.status).toBe(422);
      expect((r.body as Record<string, unknown>)["error"]).toBe("blocked_target");
    }
  });

  it("metadata IP + credentials-URL → blocked", async () => {
    for (const resource_url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://user:pass@example.com/",
    ]) {
      const r = await x402LivenessCheckPreflight({
        body: buf({ resource_url }),
        method: "POST",
      });
      expect(r.proceed).toBe(false);
    }
  });

  it("paid request with discovery-class body → proceed:false 422 (never settle)", async () => {
    const r = await x402LivenessCheckPreflight({ body: buf({}), method: "POST" });
    expect(r.proceed).toBe(false);
    if (!r.proceed) expect(r.status).toBe(422);
  });

  it("public literal IP proceeds (static allow, no DNS needed)", async () => {
    const r = await x402LivenessCheckPreflight({
      body: buf({ resource_url: "https://93.184.216.34/v1" }),
      method: "POST",
    });
    expect(r.proceed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// classifyX402Challenge — pure table tests
// ─────────────────────────────────────────────────────────────────────

describe("classifyX402Challenge", () => {
  it("fetch error / timeout / no response / 5xx → DEAD", () => {
    expect(
      classifyX402Challenge({ httpStatus: null, fetchError: "timeout_after_8000ms" })
        .status,
    ).toBe("DEAD");
    expect(classifyX402Challenge({ httpStatus: null }).reason).toBe("no_response");
    expect(classifyX402Challenge({ httpStatus: 503 })).toMatchObject({
      status: "DEAD",
      reason: "http_503_server_error",
    });
    expect(classifyX402Challenge({ httpStatus: 500 }).status).toBe("DEAD");
  });

  it("non-402 2xx/4xx → DEGRADED no_402_challenge", () => {
    const c = classifyX402Challenge({ httpStatus: 200, bodyText: "{}" });
    expect(c.status).toBe("DEGRADED");
    expect(c.reason).toContain("no_402_challenge");
    expect(classifyX402Challenge({ httpStatus: 404 }).status).toBe("DEGRADED");
  });

  it("3xx → DEGRADED redirect_not_followed (never followed: SSRF policy)", () => {
    const c = classifyX402Challenge({ httpStatus: 302 });
    expect(c.status).toBe("DEGRADED");
    expect(c.reason).toContain("redirect_302_not_followed");
  });

  it("malformed 402 bodies → DEGRADED with specific reasons", () => {
    expect(
      classifyX402Challenge({ httpStatus: 402, bodyText: "<html>pay</html>" }).reason,
    ).toBe("402_body_not_json");
    expect(
      classifyX402Challenge({ httpStatus: 402, bodyText: "[1]" }).reason,
    ).toBe("402_body_not_object");
    expect(
      classifyX402Challenge({
        httpStatus: 402,
        bodyText: JSON.stringify({ x402Version: 1 }),
      }).reason,
    ).toBe("missing_or_empty_accepts");
    const noVersion = validChallenge();
    delete (noVersion as Record<string, unknown>)["x402Version"];
    expect(
      classifyX402Challenge({ httpStatus: 402, bodyText: JSON.stringify(noVersion) })
        .reason,
    ).toBe("missing_x402Version");
  });

  it("402 with invalid accepts entries (missing payTo / zero amount) → DEGRADED", () => {
    const bad = validChallenge({
      accepts: [
        { scheme: "exact", network: "base", maxAmountRequired: "100000" }, // no payTo
        { scheme: "exact", network: "base", payTo: "0xabc", amount: "0" }, // zero
      ],
    });
    const c = classifyX402Challenge({
      httpStatus: 402,
      bodyText: JSON.stringify(bad),
    });
    expect(c.status).toBe("DEGRADED");
    expect(c.reason).toContain("invalid_accepts_entries");
    expect(c.checks.accepts_valid).toBe(false);
  });

  it("valid 402 → ALIVE with MIN price over accepts + signals", () => {
    const c = classifyX402Challenge({
      httpStatus: 402,
      bodyText: JSON.stringify(validChallenge()),
      latencyMs: 220,
    });
    expect(c.status).toBe("ALIVE");
    expect(c.reason).toBe("valid_x402_challenge");
    expect(c.checks.price_usd_min).toBeCloseTo(0.05, 9); // min(100000, 50000)/1e6
    expect(c.checks.accepts_count).toBe(2);
    expect(c.checks.accepts_valid).toBe(true);
    expect(c.checks.networks.sort()).toEqual(["base", "solana"]);
    expect(c.checks.bazaar_extension_present).toBe(true);
    expect(c.checks.input_schema_declared).toBe(true);
    expect(c.checks.x402_version).toBe(1);
    expect(c.checks.pay_to_sample).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });

  it("valid 402 but latency 6000ms → DEGRADED slow_response", () => {
    const c = classifyX402Challenge({
      httpStatus: 402,
      bodyText: JSON.stringify(validChallenge()),
      latencyMs: 6000,
    });
    expect(c.status).toBe("DEGRADED");
    expect(c.reason).toContain("slow_response");
    expect(c.checks.latency_over_5s).toBe(true);
    expect(c.checks.price_usd_min).toBeCloseTo(0.05, 9);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Handler end-to-end (stubbed fetch — no network)
// ─────────────────────────────────────────────────────────────────────

describe("x402LivenessCheck handler", () => {
  it("valid 402 → 200 ALIVE with price; probe sends NO payment headers, redirect=manual", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      response(402, JSON.stringify(validChallenge()), {
        "content-type": "application/json",
        server: "fastify",
      }),
    );
    const res = await x402LivenessCheck({
      body: buf({ resource_url: PUBLIC_URL, method: "POST", request_body: { q: 1 } }),
      method: "POST",
      fetchImpl,
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body["verdict"]["status"]).toBe("ALIVE");
    expect(body["signals"]["http_status"]).toBe(402);
    expect(body["signals"]["price_usd_min"]).toBeCloseTo(0.05, 9);
    expect(body["signals"]["server"]).toBe("fastify");
    expect(body["signals"]["content_type"]).toContain("application/json");
    expect(body["data_quality"]["probe_method"]).toBe("POST");
    expect(body["data_quality"]["redirect_policy"]).toBe("manual");
    expect(typeof body["raw"]["challenge_body"]).toBe("string");

    // Probe hygiene: exactly one call, manual redirects, no payment/auth
    expect(calls.length).toBe(1);
    const init = calls[0]!.init;
    expect(init.redirect).toBe("manual");
    const headerKeys = Object.keys(
      (init.headers ?? {}) as Record<string, string>,
    ).map((k) => k.toLowerCase());
    expect(
      headerKeys.some((k) => /payment|authorization|x-payment|signature/.test(k)),
    ).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({ q: 1 });
  });

  it("HTTP 200 → DEGRADED no_402_challenge", async () => {
    const { fetchImpl } = stubFetch(() => response(200, '{"ok":true}'));
    const res = await x402LivenessCheck({
      body: buf({ resource_url: PUBLIC_URL }),
      method: "POST",
      fetchImpl,
    });
    const body = res.body as Record<string, any>;
    expect(res.status).toBe(200);
    expect(body["verdict"]["status"]).toBe("DEGRADED");
    expect(body["verdict"]["reason"]).toContain("no_402_challenge");
    expect(body["data_quality"]["probe_method"]).toBe("GET"); // default
  });

  it("malformed 402 (HTML body) → DEGRADED", async () => {
    const { fetchImpl } = stubFetch(() => response(402, "<html>pay me</html>"));
    const res = await x402LivenessCheck({
      body: buf({ resource_url: PUBLIC_URL }),
      method: "POST",
      fetchImpl,
    });
    expect((res.body as any)["verdict"]["status"]).toBe("DEGRADED");
    expect((res.body as any)["verdict"]["reason"]).toBe("402_body_not_json");
  });

  it("3xx from target → DEGRADED, Location echoed but never followed", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      response(302, null, { location: "http://169.254.169.254/latest" }),
    );
    const res = await x402LivenessCheck({
      body: buf({ resource_url: PUBLIC_URL }),
      method: "POST",
      fetchImpl,
    });
    const body = res.body as Record<string, any>;
    expect(body["verdict"]["status"]).toBe("DEGRADED");
    expect(body["verdict"]["reason"]).toContain("redirect_302_not_followed");
    expect(body["data_quality"]["redirect_location"]).toBe(
      "http://169.254.169.254/latest",
    );
    expect(calls.length).toBe(1); // the metadata URL was NOT fetched
  });

  it("fetch abort → DEAD timeout; generic throw → DEAD network_error", async () => {
    const abortErr = new Error("This operation was aborted");
    abortErr.name = "AbortError";
    const aborting = (async () => {
      throw abortErr;
    }) as unknown as typeof fetch;
    const resA = await x402LivenessCheck({
      body: buf({ resource_url: PUBLIC_URL }),
      method: "POST",
      fetchImpl: aborting,
    });
    expect((resA.body as any)["verdict"]["status"]).toBe("DEAD");
    expect((resA.body as any)["verdict"]["reason"]).toBe("timeout_after_8000ms");

    const failing = (async () => {
      throw new Error("getaddrinfo ENOTFOUND nope.example.com");
    }) as unknown as typeof fetch;
    const resB = await x402LivenessCheck({
      body: buf({ resource_url: PUBLIC_URL }),
      method: "POST",
      fetchImpl: failing,
    });
    expect((resB.body as any)["verdict"]["status"]).toBe("DEAD");
    expect((resB.body as any)["verdict"]["reason"]).toContain("ENOTFOUND");
    expect((resB.body as any)["signals"]["http_status"]).toBeNull();
  });

  it("HTTP 503 → DEAD (still a paid 200 verdict)", async () => {
    const { fetchImpl } = stubFetch(() => response(503, "oops"));
    const res = await x402LivenessCheck({
      body: buf({ resource_url: PUBLIC_URL }),
      method: "POST",
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect((res.body as any)["verdict"]["status"]).toBe("DEAD");
    expect((res.body as any)["verdict"]["reason"]).toBe("http_503_server_error");
  });

  it("SSRF: literal private target → 422 blocked_target, fetch NEVER called", async () => {
    const { fetchImpl, calls } = stubFetch(() => response(200, "{}"));
    const res = await x402LivenessCheck({
      body: buf({ resource_url: "http://127.0.0.1:3003/v1" }),
      method: "POST",
      fetchImpl,
    });
    expect(res.status).toBe(422);
    expect((res.body as any)["error"]).toBe("blocked_target");
    expect(calls.length).toBe(0);
  });

  it("raw.challenge_body truncated to 4096 chars", async () => {
    const huge = validChallenge({ padding: "z".repeat(10_000) });
    const { fetchImpl } = stubFetch(() => response(402, JSON.stringify(huge)));
    const res = await x402LivenessCheck({
      body: buf({ resource_url: PUBLIC_URL }),
      method: "POST",
      fetchImpl,
    });
    const raw = (res.body as any)["raw"]["challenge_body"] as string;
    expect(raw.length).toBe(4096);
    expect((res.body as any)["verdict"]["status"]).toBe("ALIVE"); // full body still classified
  });

  it("validator garbage short-circuits inside the handler too", async () => {
    const { fetchImpl, calls } = stubFetch(() => response(200, "{}"));
    const res = await x402LivenessCheck({
      body: buf({ resource_url: "not a url" }),
      method: "POST",
      fetchImpl,
    });
    expect(res.status).toBe(422);
    expect(calls.length).toBe(0);
  });
});
