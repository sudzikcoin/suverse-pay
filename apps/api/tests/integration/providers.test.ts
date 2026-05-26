import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_ADMIN_BEARER,
  cleanState,
  setupStack,
  teardownStack,
  type IntegrationStack,
} from "./setup.js";

describe("GET /providers (integration)", () => {
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

  it("lists both registered adapters with their static capabilities", async () => {
    const res = await stack.app.inject({
      method: "GET",
      url: "/providers",
      headers: { authorization: TEST_ADMIN_BEARER },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.providers).toHaveLength(2);

    const cosmos = body.providers.find(
      (p: { id: string }) => p.id === "cosmos-pay",
    );
    expect(cosmos).toBeDefined();
    expect(cosmos.capabilities).toContainEqual(
      expect.objectContaining({
        network: "cosmos:noble-1",
        asset: "uusdc",
        scheme: "exact_cosmos_authz",
        isStatic: true,
      }),
    );

    const cdp = body.providers.find(
      (p: { id: string }) => p.id === "coinbase-cdp",
    );
    expect(cdp).toBeDefined();
    expect(cdp.capabilities).toContainEqual(
      expect.objectContaining({
        network: "eip155:8453",
        asset: "0xUSDC",
        scheme: "exact",
        isStatic: true,
      }),
    );
  });

  it("includes health summary fields (unknown when no checks recorded)", async () => {
    const res = await stack.app.inject({
      method: "GET",
      url: "/providers",
      headers: { authorization: TEST_ADMIN_BEARER },
    });
    const body = res.json();
    for (const p of body.providers) {
      expect(p.health).toBeDefined();
      expect(p.health.status).toBe("unknown");
    }
  });
});
