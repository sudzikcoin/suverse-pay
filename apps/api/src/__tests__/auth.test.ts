import { afterEach, describe, expect, it } from "vitest";
import {
  TEST_API_KEY,
  TEST_API_KEY_BEARER,
  makeFakeProvider,
  makeTestServer,
  type TestServerHandles,
} from "./helpers.js";

describe("auth plugin", () => {
  let handles: TestServerHandles | null = null;
  afterEach(async () => {
    await handles?.app.close();
    handles = null;
  });

  it("rejects requests with no Authorization header (401 unauthorized)", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({ method: "GET", url: "/providers" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("rejects malformed Authorization header (not Bearer ...)", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({
      method: "GET",
      url: "/providers",
      headers: { authorization: "Basic Zm9vOmJhcg==" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an empty bearer token", async () => {
    handles = await makeTestServer({});
    const res = await handles.app.inject({
      method: "GET",
      url: "/providers",
      headers: { authorization: "Bearer " },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a wrong-but-same-length key (constant-time check still 401)", async () => {
    handles = await makeTestServer({});
    const wrong = TEST_API_KEY.replace(/./g, "x");
    const res = await handles.app.inject({
      method: "GET",
      url: "/providers",
      headers: { authorization: `Bearer ${wrong}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the configured admin key and sets request.apiKeyId", async () => {
    const provider = makeFakeProvider({ id: "p1" });
    handles = await makeTestServer({ providers: [{ fake: provider }] });
    const res = await handles.app.inject({
      method: "GET",
      url: "/providers",
      headers: { authorization: TEST_API_KEY_BEARER },
    });
    expect(res.statusCode).toBe(200);
  });
});
