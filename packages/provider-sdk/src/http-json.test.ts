import { ProviderError } from "@suverse-pay/core-types";
import { describe, expect, it, vi } from "vitest";
import { httpJson, httpStatusToErrorCode } from "./http-json.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface FetchScript {
  responses: ReadonlyArray<Response | Error>;
}

function makeFetch(script: FetchScript): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    if (i >= script.responses.length) {
      throw new Error(`fetch called more times than scripted (${i + 1})`);
    }
    const next = script.responses[i++]!;
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

describe("httpJson — happy path", () => {
  it("GET returns parsed JSON", async () => {
    const { fetch, calls } = makeFetch({
      responses: [jsonResponse({ hello: "world" })],
    });
    const result = await httpJson<{ hello: string }>("https://example.test/x", {
      fetchImpl: fetch,
    });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ hello: "world" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("POST serializes body to JSON and sets Content-Type", async () => {
    const { fetch, calls } = makeFetch({
      responses: [jsonResponse({ ok: true }, 201)],
    });
    await httpJson("https://example.test/x", {
      method: "POST",
      body: { foo: 1 },
      fetchImpl: fetch,
    });
    expect(calls[0]!.init.body).toBe(JSON.stringify({ foo: 1 }));
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Accept"]).toBe("application/json");
  });

  it("respects custom headers", async () => {
    const { fetch, calls } = makeFetch({
      responses: [jsonResponse({})],
    });
    await httpJson("https://example.test/x", {
      headers: { Authorization: "Bearer xyz" },
      fetchImpl: fetch,
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer xyz");
  });
});

describe("httpJson — Idempotency-Key", () => {
  it("does NOT send Idempotency-Key when caller didn't provide one", async () => {
    const { fetch, calls } = makeFetch({
      responses: [jsonResponse({})],
    });
    await httpJson("https://example.test/settle", {
      method: "POST",
      body: {},
      fetchImpl: fetch,
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("sends Idempotency-Key when caller provides one", async () => {
    const { fetch, calls } = makeFetch({
      responses: [jsonResponse({})],
    });
    await httpJson("https://example.test/settle", {
      method: "POST",
      body: {},
      idempotencyKey: "client-key-42",
      fetchImpl: fetch,
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("client-key-42");
  });

  it("propagates the SAME Idempotency-Key on every retry attempt", async () => {
    // CRITICAL invariant: a retry inside the adapter must not change
    // the idempotency key, otherwise the downstream provider would
    // double-settle.
    const { fetch, calls } = makeFetch({
      responses: [
        textResponse("boom", 503),
        textResponse("boom", 503),
        jsonResponse({ settled: true }),
      ],
    });
    const result = await httpJson("https://example.test/settle", {
      method: "POST",
      body: {},
      idempotencyKey: "client-key-42",
      retry: { maxAttempts: 3, sleep: () => Promise.resolve() },
      fetchImpl: fetch,
    });
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe("client-key-42");
    }
  });
});

describe("httpJson — error mapping", () => {
  it("maps 5xx to provider_internal_error (retryable)", async () => {
    const { fetch } = makeFetch({
      responses: [textResponse("nope", 500)],
    });
    try {
      await httpJson("https://example.test/x", { fetchImpl: fetch });
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).code).toBe("provider_internal_error");
      expect((err as ProviderError).isRetryable()).toBe(true);
    }
  });

  it("maps 503 to temporary_unavailable (retryable)", async () => {
    const { fetch } = makeFetch({
      responses: [textResponse("maintenance", 503)],
    });
    await expect(httpJson("https://example.test/x", { fetchImpl: fetch })).rejects.toMatchObject({
      code: "temporary_unavailable",
    });
  });

  it("maps 429 to rate_limited (retryable)", async () => {
    const { fetch } = makeFetch({
      responses: [textResponse("slow down", 429)],
    });
    await expect(httpJson("https://example.test/x", { fetchImpl: fetch })).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("maps 401 to unauthorized (non-retryable)", async () => {
    const { fetch } = makeFetch({
      responses: [textResponse("nope", 401)],
    });
    try {
      await httpJson("https://example.test/x", { fetchImpl: fetch });
      expect.fail("should throw");
    } catch (err) {
      expect((err as ProviderError).code).toBe("unauthorized");
      expect((err as ProviderError).isRetryable()).toBe(false);
    }
  });

  it("maps 404 to not_found", async () => {
    const { fetch } = makeFetch({
      responses: [textResponse("missing", 404)],
    });
    await expect(httpJson("https://example.test/x", { fetchImpl: fetch })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("maps other 4xx to invalid_request", async () => {
    const { fetch } = makeFetch({
      responses: [textResponse("bad", 400)],
    });
    await expect(httpJson("https://example.test/x", { fetchImpl: fetch })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("maps fetch throw to network_error", async () => {
    const { fetch } = makeFetch({
      responses: [new Error("ECONNREFUSED")],
    });
    await expect(httpJson("https://example.test/x", { fetchImpl: fetch })).rejects.toMatchObject({
      code: "network_error",
    });
  });

  it("maps non-JSON body on 2xx to provider_internal_error", async () => {
    const { fetch } = makeFetch({
      responses: [new Response("not json", { status: 200 })],
    });
    await expect(httpJson("https://example.test/x", { fetchImpl: fetch })).rejects.toMatchObject({
      code: "provider_internal_error",
    });
  });

  it("attaches providerId when supplied", async () => {
    const { fetch } = makeFetch({
      responses: [textResponse("boom", 500)],
    });
    try {
      await httpJson("https://example.test/x", { providerId: "cosmos-pay", fetchImpl: fetch });
      expect.fail("should throw");
    } catch (err) {
      expect((err as ProviderError).providerId).toBe("cosmos-pay");
    }
  });
});

describe("httpJson — timeout", () => {
  it("throws ProviderError('timeout') when fetch hangs past timeoutMs", async () => {
    const slowFetch: typeof globalThis.fetch = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const reason = (init.signal as AbortSignal).reason;
          reject(reason instanceof Error ? reason : new Error("aborted"));
        });
      });
    await expect(
      httpJson("https://example.test/x", { timeoutMs: 20, fetchImpl: slowFetch }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("httpJson — retry with errors", () => {
  it("retries on 503 then succeeds", async () => {
    const { fetch, calls } = makeFetch({
      responses: [
        textResponse("down", 503),
        jsonResponse({ ok: true }),
      ],
    });
    const result = await httpJson("https://example.test/x", {
      retry: { maxAttempts: 3, sleep: () => Promise.resolve() },
      fetchImpl: fetch,
    });
    expect(result.data).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry on 401", async () => {
    const { fetch, calls } = makeFetch({
      responses: [textResponse("denied", 401)],
    });
    await expect(
      httpJson("https://example.test/x", {
        retry: { maxAttempts: 5, sleep: () => Promise.resolve() },
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(calls).toHaveLength(1);
  });
});

describe("httpStatusToErrorCode", () => {
  it("maps known statuses", () => {
    expect(httpStatusToErrorCode(429)).toBe("rate_limited");
    expect(httpStatusToErrorCode(408)).toBe("timeout");
    expect(httpStatusToErrorCode(503)).toBe("temporary_unavailable");
    expect(httpStatusToErrorCode(500)).toBe("provider_internal_error");
    expect(httpStatusToErrorCode(502)).toBe("provider_internal_error");
    expect(httpStatusToErrorCode(401)).toBe("unauthorized");
    expect(httpStatusToErrorCode(403)).toBe("unauthorized");
    expect(httpStatusToErrorCode(404)).toBe("not_found");
    expect(httpStatusToErrorCode(400)).toBe("invalid_request");
    expect(httpStatusToErrorCode(422)).toBe("invalid_request");
  });
});

// Suppress unused-var warning in case vi import isn't strictly required.
void vi;
