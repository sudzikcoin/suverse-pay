import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ThirdwebX402Adapter } from "./adapter.js";
import { ThirdwebSupportedResponseSchema } from "./wire.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  __dirname,
  "../test-fixtures/thirdweb-supported.json",
);

const OPTIMISM = "eip155:10";
const OPTIMISM_USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const ETH_MAINNET = "eip155:1";
const ETH_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AVAX = "eip155:43114";

/**
 * Integration test against Thirdweb's live Nexus `/supported`. Mocked
 * unit tests in adapter.test.ts are the correctness gate; this test
 * guards against silent API drift (a network disappearing, an EIP-712
 * domain `name` changing, the v1/v2 labeling shifting).
 *
 * Caching: same strategy as the PayAI integration test — first run
 * hits the API and writes the response to `test-fixtures/`; subsequent
 * runs read from the fixture. Delete the fixture to refresh. If the
 * real API is unreachable, the test logs a warning and passes (mocked
 * tests are the authoritative correctness gate).
 *
 * The /supported endpoint is the only one we hit live; /verify and
 * /settle would require a Nexus API key + spending a tx on a live
 * network and belong in a real-network smoke test, not unit/integration.
 */
describe("ThirdwebX402Adapter — real API integration", () => {
  it("/supported response parses and includes Optimism + Ethereum mainnet USDC", async () => {
    let body: unknown;
    if (existsSync(FIXTURE_PATH)) {
      const text = readFileSync(FIXTURE_PATH, "utf8");
      body = JSON.parse(text);
    } else {
      try {
        const resp = await fetch("https://nexus-api.thirdweb.com/supported", {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          console.warn(
            `[thirdweb.integration] HTTP ${resp.status} from /supported; skipping assertions`,
          );
          return;
        }
        body = await resp.json();
        mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
        writeFileSync(FIXTURE_PATH, JSON.stringify(body, null, 2));
      } catch (err) {
        console.warn(
          `[thirdweb.integration] Thirdweb unreachable, skipping: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
    }

    // 1. The response matches our wire schema.
    const parsed = ThirdwebSupportedResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // 2. Headline targets must be present — losing them is a routing
    //    regression the gateway has to notice fast.
    const opt = parsed.data.kinds.find(
      (k) => k.network === OPTIMISM && k.scheme === "exact",
    );
    expect(opt).toBeDefined();
    expect(opt?.extra?.defaultAsset?.address).toBe(OPTIMISM_USDC);
    expect(opt?.extra?.defaultAsset?.eip712.name).toBe("USD Coin");
    expect(opt?.extra?.defaultAsset?.eip712.version).toBe("2");
    expect(opt?.extra?.defaultAsset?.eip712.primaryType).toBe(
      "TransferWithAuthorization",
    );

    const eth = parsed.data.kinds.find(
      (k) => k.network === ETH_MAINNET && k.scheme === "exact",
    );
    expect(eth).toBeDefined();
    expect(eth?.extra?.defaultAsset?.address).toBe(ETH_USDC);
    expect(eth?.extra?.defaultAsset?.eip712.name).toBe("USD Coin");

    // 3. The Avalanche entry is also expected (PayAI also covers it;
    //    Thirdweb advertising it is a future failover candidate).
    const avax = parsed.data.kinds.find(
      (k) => k.network === AVAX && k.scheme === "exact",
    );
    expect(avax).toBeDefined();

    // 4. Adapter's discoverCapabilities() works against the live shape.
    const wrapped: Response = {
      status: 200,
      ok: true,
      json: async () => body,
    } as Response;
    const adapter = new ThirdwebX402Adapter({
      capabilities: [
        { network: OPTIMISM, asset: OPTIMISM_USDC, scheme: "exact" },
        { network: ETH_MAINNET, asset: ETH_USDC, scheme: "exact" },
      ],
      estimatedFeeUsd: "0.001",
      fetchImpl: async () => wrapped,
    });
    const caps = await adapter.discoverCapabilities();
    const networks = caps.map((c) => c.network).sort();
    expect(networks).toEqual([ETH_MAINNET, OPTIMISM].sort());
  });
});
