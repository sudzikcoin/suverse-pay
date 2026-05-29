import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { T402SupportedResponseSchema } from "./wire.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "../test-fixtures/t402-supported.json");

const NAMESPACES_EXPECTED = [
  "eip155",
  "tron",
  "solana",
  "cosmos",
  "aptos",
  "near",
  "polkadot",
  "stacks",
  "stellar",
  "tezos",
  "ton",
] as const;

/**
 * Live `/supported` probe against t402-io's hosted facilitator.
 * Mocked unit tests in adapter.test.ts are the correctness gate;
 * this guards against silent API drift — t402-io dropping a
 * namespace or renaming a scheme.
 *
 * t402-io is open access on /supported (no auth). Test passes
 * silently when the facilitator is unreachable so CI never blocks
 * on third-party downtime.
 */
describe("T402IoAdapter — real /supported integration", () => {
  it("response parses and advertises 11 namespaces including cosmos:noble-1 mainnet", async () => {
    let body: unknown;
    if (existsSync(FIXTURE_PATH)) {
      body = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    } else {
      try {
        const resp = await fetch("https://facilitator.t402.io/supported", {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          console.warn(
            `[t402.integration] HTTP ${resp.status} from /supported; skipping`,
          );
          return;
        }
        body = await resp.json();
        mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
        writeFileSync(FIXTURE_PATH, JSON.stringify(body, null, 2));
      } catch (err) {
        console.warn(
          `[t402.integration] t402-io unreachable, skipping: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
    }

    // 1. Schema parses.
    const parsed = T402SupportedResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // 2. All 11 namespaces present.
    const namespaces = new Set<string>();
    for (const k of parsed.data.kinds) {
      const ns = k.network.split(":")[0];
      if (ns !== undefined) namespaces.add(ns);
    }
    for (const expected of NAMESPACES_EXPECTED) {
      expect(namespaces.has(expected)).toBe(true);
    }

    // 3. cosmos:noble-1 MAINNET is present (the headline NEW route).
    // Schema is `exact-direct` for Cosmos chains, NOT plain `exact`
    // — different from the EVM/Solana `exact` scheme.
    const noble = parsed.data.kinds.find(
      (k) => k.network === "cosmos:noble-1" && k.scheme === "exact-direct",
    );
    expect(noble).toBeDefined();

    // 4. t402Version field is on every entry (NOT x402Version).
    expect(parsed.data.kinds.every((k) => k.t402Version === 2)).toBe(true);
  });
});
