import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("buildServer", () => {
  it("constructs without throwing and exposes the underlying server", () => {
    const s = buildServer();
    expect(s).toBeDefined();
    // The McpServer wrapper from the SDK exposes its underlying
    // Server instance on .server — pinning this here keeps the
    // contract visible if the SDK shape changes.
    expect((s as { server: unknown }).server).toBeDefined();
  });
});
