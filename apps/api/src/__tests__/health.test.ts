import { afterEach, describe, expect, it } from "vitest";
import { makeTestServer, type TestServerHandles } from "./helpers.js";

describe("GET /health", () => {
  let handles: TestServerHandles | null = null;
  afterEach(async () => {
    await handles?.app.close();
    handles = null;
  });

  it("returns 200 OK without an Authorization header (liveness probe)", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("ignores any Authorization header and never lights up auth path", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer wrong-key" },
    });
    expect(res.statusCode).toBe(200);
  });
});
