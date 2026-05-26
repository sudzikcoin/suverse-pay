import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_ADMIN_BEARER,
  cleanState,
  setupStack,
  teardownStack,
  type IntegrationStack,
} from "./setup.js";

describe("GET /health (integration)", () => {
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

  it("returns 200 OK without auth", async () => {
    const res = await stack.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("returns 200 OK with auth too (does not error on it)", async () => {
    const res = await stack.app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: TEST_ADMIN_BEARER },
    });
    expect(res.statusCode).toBe(200);
  });
});
