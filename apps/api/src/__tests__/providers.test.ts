import { afterEach, describe, expect, it } from "vitest";
import {
  TEST_API_KEY_BEARER,
  makeFakeProvider,
  makeTestServer,
  type TestServerHandles,
} from "./helpers.js";

describe("GET /providers", () => {
  let handles: TestServerHandles | null = null;
  afterEach(async () => {
    await handles?.app.close();
    handles = null;
  });

  it("returns an empty providers list when none are registered", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({
      method: "GET",
      url: "/providers",
      headers: { authorization: TEST_API_KEY_BEARER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providers: [] });
  });

  it("lists registered providers with their capabilities + health", async () => {
    const cosmos = makeFakeProvider({ id: "cosmos-pay" });
    const cdp = makeFakeProvider({ id: "coinbase-cdp" });
    handles = await makeTestServer({
      providers: [
        {
          fake: cosmos,
          capabilities: [
            {
              providerId: "cosmos-pay",
              network: "cosmos:noble-1",
              asset: "uusdc",
              scheme: "exact_cosmos_authz",
              isStatic: true,
              isDiscovered: false,
              discoveredAt: null,
              supersededAt: null,
            },
          ],
        },
        {
          fake: cdp,
          capabilities: [
            {
              providerId: "coinbase-cdp",
              network: "eip155:8453",
              asset: "0xUSDC",
              scheme: "exact",
              isStatic: true,
              isDiscovered: true,
              discoveredAt: new Date("2026-05-26T11:00:00Z"),
              supersededAt: null,
            },
          ],
        },
      ],
      healthSummaries: new Map([
        [
          "cosmos-pay",
          {
            providerId: "cosmos-pay",
            recentAttempts: 5,
            recentFailures: 0,
            lastCheck: {
              status: "healthy",
              checkedAt: new Date("2026-05-26T11:59:30Z"),
            },
            successRate7d: 0.99,
            avgLatencyMs7d: 410,
          },
        ],
      ]),
    });
    const res = await handles.app.inject({
      method: "GET",
      url: "/providers",
      headers: { authorization: TEST_API_KEY_BEARER },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.providers).toHaveLength(2);
    const cosmosRow = body.providers.find(
      (p: { id: string }) => p.id === "cosmos-pay",
    );
    expect(cosmosRow.health.status).toBe("healthy");
    expect(cosmosRow.health.successRate7d).toBe(0.99);
    expect(cosmosRow.capabilities[0].network).toBe("cosmos:noble-1");
    const cdpRow = body.providers.find(
      (p: { id: string }) => p.id === "coinbase-cdp",
    );
    expect(cdpRow.health.status).toBe("unknown"); // no summary
    expect(cdpRow.capabilities[0].discoveredAt).toBe("2026-05-26T11:00:00.000Z");
  });

  it("requires auth (no header → 401, not 200)", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({ method: "GET", url: "/providers" });
    expect(res.statusCode).toBe(401);
  });
});
