import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BofaiX402Adapter } from "./adapter.js";
import { BofaiSupportedResponseSchema } from "./wire.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "../test-fixtures/bofai-supported.json");

const TRON_MAINNET = "tron:mainnet";
const TRON_NILE = "tron:nile";
const BSC = "eip155:56";
const BSC_TESTNET = "eip155:97";

/**
 * Real `/supported` probe against BofAI's hosted facilitator. Cached
 * to test-fixtures on first run. The mocked adapter tests are the
 * correctness gate; this test guards against silent API drift —
 * BofAI dropping a network, renaming a scheme, etc.
 *
 * Open access (no auth required) — confirmed in adapter.test.ts.
 * If the facilitator is unreachable, log a warning and skip.
 */
describe("BofaiX402Adapter — real /supported integration", () => {
  it("/supported response parses and includes the 10 advertised (network, scheme) entries", async () => {
    let body: unknown;
    if (existsSync(FIXTURE_PATH)) {
      const text = readFileSync(FIXTURE_PATH, "utf8");
      body = JSON.parse(text);
    } else {
      try {
        const resp = await fetch("https://facilitator.bankofai.io/supported", {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          console.warn(
            `[bofai.integration] HTTP ${resp.status} from /supported; skipping assertions`,
          );
          return;
        }
        body = await resp.json();
        mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
        writeFileSync(FIXTURE_PATH, JSON.stringify(body, null, 2));
      } catch (err) {
        console.warn(
          `[bofai.integration] BofAI unreachable, skipping: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
    }

    const parsed = BofaiSupportedResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // The exact set of advertised (network, scheme) entries — TRON
    // mainnet/nile get all three schemes, BSC mainnet/testnet get
    // exact + exact_permit only (no GasFree on EVM). Match this set
    // exactly so silent additions/removals fail loudly.
    const advertised = parsed.data.kinds
      .map((k) => `${k.network}:${k.scheme}`)
      .sort();
    expect(advertised).toEqual(
      [
        `${TRON_MAINNET}:exact`,
        `${TRON_MAINNET}:exact_permit`,
        `${TRON_MAINNET}:exact_gasfree`,
        `${TRON_NILE}:exact`,
        `${TRON_NILE}:exact_permit`,
        `${TRON_NILE}:exact_gasfree`,
        `${BSC}:exact`,
        `${BSC}:exact_permit`,
        `${BSC_TESTNET}:exact`,
        `${BSC_TESTNET}:exact_permit`,
      ].sort(),
    );

    // Adapter's discovery against the live shape, sanity check.
    const wrapped: Response = {
      status: 200,
      ok: true,
      json: async () => body,
    } as Response;
    const adapter = new BofaiX402Adapter({
      capabilities: [
        { network: TRON_MAINNET, asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", scheme: "exact_gasfree" },
        { network: BSC, asset: "0x55d398326f99059fF775485246999027B3197955", scheme: "exact" },
      ],
      estimatedFeeUsd: "0.001",
      fetchImpl: async () => wrapped,
    });
    const caps = await adapter.discoverCapabilities();
    expect(caps.map((c) => `${c.network}:${c.scheme}`).sort()).toEqual(
      [`${TRON_MAINNET}:exact_gasfree`, `${BSC}:exact`].sort(),
    );
  });
});
