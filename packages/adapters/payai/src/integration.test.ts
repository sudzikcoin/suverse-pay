import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PayAiAdapter } from "./adapter.js";
import { PayAiSupportedResponseSchema } from "./wire.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "../test-fixtures/payai-supported.json");

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Integration test against the live PayAI `/supported` endpoint. The
 * mocked unit tests in adapter.test.ts are the correctness gate; this
 * test exists to catch silent API drift (PayAI changing a field name,
 * dropping Solana mainnet, etc).
 *
 * Caching: same strategy as the discovery package's bazaar.integration
 * test — first run hits the API and writes the response to
 * `test-fixtures/`; subsequent runs read from the fixture. Delete the
 * fixture to refresh. If the real API is unreachable on the first run,
 * the test logs a warning and passes (the mocked tests are still the
 * authoritative gate).
 */
describe("PayAiAdapter — real API integration", () => {
  it("/supported response parses and includes Solana mainnet x402 v2", async () => {
    let body: unknown;
    if (existsSync(FIXTURE_PATH)) {
      const text = readFileSync(FIXTURE_PATH, "utf8");
      body = JSON.parse(text);
    } else {
      try {
        const resp = await fetch("https://facilitator.payai.network/supported", {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          console.warn(
            `[payai.integration] HTTP ${resp.status} from /supported; skipping assertions`,
          );
          return;
        }
        body = await resp.json();
        mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
        writeFileSync(FIXTURE_PATH, JSON.stringify(body, null, 2));
      } catch (err) {
        console.warn(
          `[payai.integration] PayAI unreachable, skipping: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
    }

    // 1. The response matches our wire schema.
    const parsed = PayAiSupportedResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // 2. At least one x402 v2 Solana mainnet entry exists. This is the
    //    capability our gateway relies on; if PayAI drops it, the test
    //    must surface that loudly.
    const v2Solana = parsed.data.kinds.find(
      (k) =>
        k.x402Version === 2 &&
        k.scheme === "exact" &&
        k.network === SOLANA_MAINNET,
    );
    expect(v2Solana).toBeDefined();
    expect(v2Solana?.extra?.feePayer).toBeTruthy();

    // 3. Adapter's discoverCapabilities() works against the live shape
    //    (re-uses the same parse path through a stubbed fetch).
    const wrapped: Response = {
      status: 200,
      ok: true,
      json: async () => body,
    } as Response;
    const adapter = new PayAiAdapter({
      capabilities: [
        { network: SOLANA_MAINNET, asset: SOLANA_USDC_MINT, scheme: "exact" },
      ],
      estimatedFeeUsd: "0.001",
      fetchImpl: async () => wrapped,
    });
    const caps = await adapter.discoverCapabilities();
    expect(caps).toEqual([
      { network: SOLANA_MAINNET, asset: SOLANA_USDC_MINT, scheme: "exact" },
    ]);
  });
});
