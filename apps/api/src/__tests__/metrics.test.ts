import { afterEach, describe, expect, it } from "vitest";
import {
  TEST_API_KEY_BEARER,
  makeTestServer,
  type TestServerHandles,
} from "./helpers.js";

describe("GET /metrics/summary", () => {
  let handles: TestServerHandles | null = null;
  afterEach(async () => {
    await handles?.app.close();
    handles = null;
  });

  it("returns the metrics object from ServerContext.loadMetrics", async () => {
    handles = await makeTestServer({
      metrics: {
        totals: {
          payments: 100,
          settled: 95,
          failed: 4,
          pending: 1,
          successRate: 0.95,
        },
        providers: [
          {
            providerId: "cosmos-pay",
            attempts: 60,
            successes: 58,
            failures: 2,
            avgLatencyMs: 420,
          },
          {
            providerId: "coinbase-cdp",
            attempts: 40,
            successes: 37,
            failures: 3,
            avgLatencyMs: 210,
          },
        ],
        generatedAt: "2026-05-26T12:00:00Z",
      },
    });
    const res = await handles.app.inject({
      method: "GET",
      url: "/metrics/summary",
      headers: { authorization: TEST_API_KEY_BEARER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals.payments).toBe(100);
    expect(res.json().providers).toHaveLength(2);
  });

  it("requires auth", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({
      method: "GET",
      url: "/metrics/summary",
    });
    expect(res.statusCode).toBe(401);
  });
});
