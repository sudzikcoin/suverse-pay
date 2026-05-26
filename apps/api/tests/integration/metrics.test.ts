import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_ADMIN_BEARER,
  cleanState,
  setupStack,
  teardownStack,
  type IntegrationStack,
} from "./setup.js";

describe("GET /metrics/summary (integration)", () => {
  let stack: IntegrationStack;

  beforeAll(async () => {
    stack = await setupStack();
  });
  afterAll(async () => {
    await teardownStack(stack);
  });
  beforeEach(async () => {
    await cleanState(stack);
  });

  it("returns aggregate stats from the metrics loader", async () => {
    stack.metricsRef.value = {
      totals: {
        payments: 42,
        settled: 40,
        failed: 1,
        pending: 1,
        successRate: 40 / 42,
      },
      providers: [
        {
          providerId: "cosmos-pay",
          attempts: 30,
          successes: 29,
          failures: 1,
          avgLatencyMs: 415,
        },
        {
          providerId: "coinbase-cdp",
          attempts: 12,
          successes: 11,
          failures: 1,
          avgLatencyMs: 220,
        },
      ],
      generatedAt: "2026-05-26T12:00:00Z",
    };
    const res = await stack.app.inject({
      method: "GET",
      url: "/metrics/summary",
      headers: { authorization: TEST_ADMIN_BEARER },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.payments).toBe(42);
    expect(body.providers).toHaveLength(2);
    expect(body.providers[0]!.providerId).toBe("cosmos-pay");
  });

  it("requires auth", async () => {
    const res = await stack.app.inject({
      method: "GET",
      url: "/metrics/summary",
    });
    expect(res.statusCode).toBe(401);
  });
});
