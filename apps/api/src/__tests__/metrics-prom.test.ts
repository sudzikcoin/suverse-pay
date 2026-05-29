import { afterEach, describe, expect, it } from "vitest";
import {
  facilitatorRateLimitHitsTotal,
  facilitatorSettleTotal,
  metricsRegistry,
} from "../lib/metrics.js";
import { makeTestServer, type TestServerHandles } from "./helpers.js";

describe("GET /metrics (Prometheus text format)", () => {
  let handles: TestServerHandles | null = null;
  afterEach(async () => {
    await handles?.app.close();
    handles = null;
  });

  it("returns Prometheus exposition format with content-type 0.0.4", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    // prom-client's contentType is exactly this:
    //   text/plain; version=0.0.4; charset=utf-8
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["content-type"]).toContain("version=0.0.4");
  });

  it("does NOT require authentication (Prometheus scrape path)", async () => {
    // /metrics/summary returns 401 unauth (see metrics.test.ts);
    // /metrics is the *scrape* path and must be open so Prometheus
    // running in docker compose can hit it without an admin key.
    handles = await makeTestServer({});
    const res = await handles.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
  });

  it("exposes the canonical gauges defined in lib/metrics.ts", async () => {
    // Seed at least one label so the # TYPE line and a sample appear in
    // the output. Otherwise an empty gauge only emits the metadata
    // lines, which is still valid Prometheus but harder to assert on.
    facilitatorSettleTotal
      .labels({ adapter: "thirdweb-x402", network: "eip155:10", status: "settled" })
      .set(7);
    facilitatorRateLimitHitsTotal
      .labels({ resource_key_label: "smoke-test-key" })
      .inc(2);

    handles = await makeTestServer({});
    const res = await handles.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // Each metric should appear with its TYPE annotation.
    expect(body).toMatch(/# TYPE facilitator_settle_total gauge/);
    expect(body).toMatch(/# TYPE facilitator_verify_total gauge/);
    expect(body).toMatch(/# TYPE facilitator_failover_events_total gauge/);
    expect(body).toMatch(/# TYPE facilitator_rate_limit_hits_total gauge/);
    expect(body).toMatch(/# TYPE adapter_health gauge/);
    expect(body).toMatch(/# TYPE payment_amount_sum gauge/);
    expect(body).toMatch(/# TYPE payment_amount_count gauge/);
    // Seeded values should be in the body.
    expect(body).toMatch(
      /facilitator_settle_total\{[^}]*adapter="thirdweb-x402"[^}]*\} 7/,
    );
    expect(body).toMatch(
      /facilitator_rate_limit_hits_total\{[^}]*resource_key_label="smoke-test-key"[^}]*\} 2/,
    );
    // Default node metrics are also exposed.
    expect(body).toMatch(/process_cpu_user_seconds_total/);
  });

  it("includes the default service label on every series", async () => {
    facilitatorSettleTotal.reset();
    facilitatorSettleTotal
      .labels({ adapter: "cosmos-pay", network: "cosmos:noble-1", status: "settled" })
      .set(1);
    handles = await makeTestServer({});
    const res = await handles.app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toMatch(/service="suverse-pay-api"/);
    // Cleanup so other tests start clean.
    facilitatorSettleTotal.reset();
    metricsRegistry.resetMetrics();
  });
});
