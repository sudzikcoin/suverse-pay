/**
 * Unit tests for the pre-charge upstream health probe.
 *
 * All tests inject a `fetchImpl` mock so nothing hits the real
 * network. The cases mirror the classification table in
 * `upstream-health.ts`:
 *
 *   - HEAD → 200/3xx        → ok
 *   - HEAD → 401/403/404/429 → ok (server alive, endpoint gated)
 *   - HEAD → 500/503         → not ok (upstream_5xx)
 *   - HEAD → 405, GET → 200  → ok (fallback path)
 *   - HEAD → 501, GET → 200  → ok (fallback path)
 *   - HEAD → 405, GET → 502  → not ok (fallback finds 5xx)
 *   - fetch throws AbortError → not ok (timeout)
 *   - fetch throws TypeError(cause=AbortError) → not ok (timeout)
 *   - fetch throws TypeError                  → not ok (network_error)
 *   - real timer test: slow upstream beyond timeoutMs → timeout
 *
 * Plus a direct test of the named status policy: `isHealthyStatus`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  checkUpstreamHealth,
  isHealthyStatus,
} from "../src/upstream-health.js";

function bodyless(status: number): Response {
  // ReadableStream-backed body so `.cancel()` is exercised.
  const body = new ReadableStream({
    start(c) {
      c.close();
    },
  });
  return new Response(body, { status });
}

describe("isHealthyStatus", () => {
  it("treats every 4xx as healthy — gated upstream is still up", () => {
    for (const s of [400, 401, 403, 404, 405, 410, 418, 429, 451, 499]) {
      expect(isHealthyStatus(s)).toBe(true);
    }
  });
  it("treats 1xx/2xx/3xx as healthy", () => {
    for (const s of [100, 200, 201, 204, 301, 302, 304, 399]) {
      expect(isHealthyStatus(s)).toBe(true);
    }
  });
  it("treats 5xx as unhealthy", () => {
    for (const s of [500, 501, 502, 503, 504, 599]) {
      expect(isHealthyStatus(s)).toBe(false);
    }
  });
});

describe("checkUpstreamHealth", () => {
  it("returns ok for HEAD 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(bodyless(200));
    const res = await checkUpstreamHealth({
      url: "https://up.example/x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.method).toBe("HEAD");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("HEAD");
  });

  it.each([301, 302, 307, 308])("returns ok for HEAD %i (redirect)", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(bodyless(status));
    const res = await checkUpstreamHealth({
      url: "https://up.example/x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(status);
  });

  it.each([401, 403, 404, 429])(
    "returns ok for HEAD %i — gated upstream is still alive",
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(bodyless(status));
      const res = await checkUpstreamHealth({
        url: "https://up.example/x",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.ok).toBe(true);
      expect(res.status).toBe(status);
    },
  );

  it.each([500, 502, 503, 504])(
    "returns upstream_5xx for HEAD %i",
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(bodyless(status));
      const res = await checkUpstreamHealth({
        url: "https://up.example/x",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("upstream_5xx");
      expect(res.status).toBe(status);
    },
  );

  it("falls back to GET when HEAD returns 405", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(bodyless(405))
      .mockResolvedValueOnce(bodyless(200));
    const res = await checkUpstreamHealth({
      url: "https://up.example/x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.method).toBe("GET");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("HEAD");
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe("GET");
  });

  it("falls back to GET when HEAD returns 501", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(bodyless(501))
      .mockResolvedValueOnce(bodyless(200));
    const res = await checkUpstreamHealth({
      url: "https://up.example/x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("GET");
  });

  it("classifies fallback GET 502 as upstream_5xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(bodyless(405))
      .mockResolvedValueOnce(bodyless(502));
    const res = await checkUpstreamHealth({
      url: "https://up.example/x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("upstream_5xx");
    expect(res.method).toBe("GET");
    expect(res.status).toBe(502);
  });

  it("returns timeout when fetch throws AbortError", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const fetchImpl = vi.fn().mockRejectedValueOnce(abortErr);
    const res = await checkUpstreamHealth({
      url: "https://up.example/x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("timeout");
  });

  it("returns timeout when fetch throws TypeError with AbortError cause", async () => {
    // Node 20+ fetch wraps abort signals like this.
    const cause = new Error("This operation was aborted");
    cause.name = "AbortError";
    const wrapped = new TypeError("fetch failed");
    (wrapped as unknown as { cause: unknown }).cause = cause;
    const fetchImpl = vi.fn().mockRejectedValueOnce(wrapped);
    const res = await checkUpstreamHealth({
      url: "https://up.example/x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("timeout");
  });

  it("returns network_error for generic fetch failures (DNS, ECONNREFUSED, …)", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const res = await checkUpstreamHealth({
      url: "https://up.example/x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("network_error");
  });

  it("times out a slow upstream via the real abort budget", async () => {
    // A fetch impl that never resolves until aborted.
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const sig = init.signal;
          if (sig) {
            sig.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          }
        }),
    );
    const t0 = Date.now();
    const res = await checkUpstreamHealth({
      url: "https://up.example/x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 80,
    });
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("timeout");
    expect(elapsed).toBeGreaterThanOrEqual(70);
    // generous upper bound; CI runners can be jittery
    expect(elapsed).toBeLessThan(2_000);
  });

  it("reports latencyMs on the result", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(bodyless(200));
    const res = await checkUpstreamHealth({
      url: "https://up.example/x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(typeof res.latencyMs).toBe("number");
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
