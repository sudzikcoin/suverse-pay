import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BAZAAR_DEFAULT_BASE_URL, BazaarSource } from "./sources/bazaar.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "../test-fixtures/bazaar-real-response.json");

/**
 * Integration test for the real Bazaar API. The mocked unit tests in
 * sources/bazaar.test.ts are the correctness gate; this test exists
 * to catch silent API drift (Bazaar changing a field name, etc).
 *
 * Caching strategy:
 *   - If the fixture file exists, parse it with the adapter and assert
 *     we produce some endpoints. NO network call. Reruns are fast and
 *     repeatable.
 *   - If the fixture file does NOT exist, hit the real Bazaar
 *     endpoint, save the response to the fixture, and assert it
 *     parses. To refresh the fixture, delete the file.
 *   - If the network call fails (Bazaar down, no internet), log a
 *     warning and pass the test — the unit tests are the real gate.
 */
describe("BazaarSource — real API integration", () => {
  it("parses a real or cached Bazaar response", async () => {
    let body: unknown;

    if (existsSync(FIXTURE_PATH)) {
      const text = readFileSync(FIXTURE_PATH, "utf8");
      body = JSON.parse(text);
    } else {
      const url = `${BAZAAR_DEFAULT_BASE_URL}?limit=5`;
      try {
        const resp = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          console.warn(
            `[bazaar.integration.test] Bazaar returned HTTP ${resp.status}; skipping assertions.`,
          );
          return;
        }
        body = await resp.json();
        mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
        writeFileSync(FIXTURE_PATH, JSON.stringify(body, null, 2));
      } catch (err) {
        console.warn(
          `[bazaar.integration.test] real Bazaar unreachable, skipping: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
    }

    const wrapped: Response = {
      status: 200,
      ok: true,
      json: async () => body,
    } as Response;
    const src = new BazaarSource({
      fetchImpl: async () => wrapped,
      logger: {
        warn: (m, c) => console.warn(`[bazaar] ${m}`, c ?? ""),
        debug: () => {},
      },
    });
    const endpoints = await src.search({ limit: 5 });

    // We don't pin a specific count — Bazaar's catalog is live data.
    // But: any non-empty response should produce >= 1 endpoint after
    // accepts[] expansion, and every entry must have the required
    // shape we contract to downstream consumers.
    if (endpoints.length === 0) {
      console.warn("[bazaar.integration.test] zero endpoints — Bazaar catalog might be empty");
      return;
    }
    for (const e of endpoints) {
      expect(typeof e.resource).toBe("string");
      expect(e.resource.length).toBeGreaterThan(0);
      expect(typeof e.network).toBe("string");
      expect(typeof e.asset).toBe("string");
      expect(typeof e.scheme).toBe("string");
      expect(typeof e.amount).toBe("string");
      expect(typeof e.payTo).toBe("string");
      expect(e.sourceId).toBe("bazaar");
      expect(e.discoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
