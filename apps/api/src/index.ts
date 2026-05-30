import { CoinbaseCdpAdapter } from "@suverse-pay/adapter-coinbase-cdp";
import { CosmosPayAdapter } from "@suverse-pay/adapter-cosmos-pay";
import { BinanceX402Adapter } from "@suverse-pay/adapter-binance-x402";
import { BofaiX402Adapter } from "@suverse-pay/adapter-bofai-x402";
import {
  StripeMppAdapter,
  type MppAdapter,
} from "@suverse-pay/adapter-mpp-stripe";
import { PayAiAdapter } from "@suverse-pay/adapter-payai";
import { T402IoAdapter } from "@suverse-pay/adapter-t402-io";
import { ThirdwebX402Adapter } from "@suverse-pay/adapter-thirdweb-x402";
import { FacilitatorRateLimiter } from "@suverse-pay/facilitator";
import { createWebhookQueue, createWebhookWorker } from "@suverse-pay/webhooks";
import {
  CapabilityDiscoveryCron,
  HealthCheckCron,
  PaymentLedger,
  ProviderRegistry,
  RedisUsageTracker,
  type ProviderHealthSummary,
} from "@suverse-pay/orchestrator";
import { Redis } from "ioredis";
import { Pool } from "pg";
import pino from "pino";
import { loadConfig } from "./config.js";
import type { MetricsSummary, ServerContext } from "./context.js";
import { MetricsRefresher } from "./lib/metrics-refresher.js";
import { sha256Hex, ADMIN_API_KEY_ID } from "./plugins/auth.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    transport:
      config.nodeEnv === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  });

  const pool = new Pool({ connectionString: config.databaseUrl });
  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  await verifyAdminApiKey(pool, config.adminApiKey, logger);

  const registry = new ProviderRegistry(pool, {
    info: (m, c) => logger.info(c, m),
    warn: (m, c) => logger.warn(c, m),
    error: (m, c) => logger.error(c, m),
  });
  const ledger = new PaymentLedger(pool, redis);

  // ---- Provider registration ------------------------------------------
  // cosmos-pay was repointed from Noble TESTNET (grand-1) to MAINNET
  // (noble-1) on 2026-05-30. The running facilitator only serves
  // noble-1 now, so the grand-1 capability is dropped here too —
  // otherwise the discovery cron would re-supersede it on every
  // restart. To bring grand-1 back, re-add both entries here AND
  // re-add `cosmos:grand-1:exact_cosmos_authz` to ROUTING_CONFIG.
  const cosmosPay = new CosmosPayAdapter({
    baseUrl: config.cosmosPayBaseUrl,
    networkAssets: {
      "cosmos:noble-1": ["uusdc"],
    },
    estimatedFeeUsd: "0.0001",
  });
  await registry.register(cosmosPay, {
    config: { baseUrl: config.cosmosPayBaseUrl, estimatedFeeUsd: "0.0001" },
    staticCapabilities: [
      { network: "cosmos:noble-1", asset: "uusdc", scheme: "exact_cosmos_authz" },
    ],
  });

  // Static capability declarations. `asset` is the on-chain identifier
  // CDP expects to see in `PaymentRequirements.asset`:
  //   - EVM: the ERC-20 contract address (Circle's native USDC deployments).
  //   - Solana: the SPL token mint (Circle's native USDC mint).
  // The Solana network identifier is the canonical CAIP-2 mainnet
  // genesis-hash form per x402 spec — matches what signer-solana
  // produces and what Bazaar advertises. NOT `solana:mainnet`.
  const cdpCaps = [
    // EVM — Circle native USDC contracts
    { network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", scheme: "exact" },
    { network: "eip155:137", asset: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", scheme: "exact" },
    { network: "eip155:42161", asset: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", scheme: "exact" },
    // Base Sepolia — Circle's test USDC. Added in v0.3.1 to satisfy
    // scripts/smoke/real-evm/; CDP's /supported advertises this kind
    // alongside the mainnet EVM entries.
    { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", scheme: "exact" },
    // World Chain mainnet + Sepolia — CDP-confirmed via /supported.
    // Bridged Circle USDC; same EIP-712 domain shape ("USDC" / "2")
    // as Base Sepolia. Phase 4 block 1.
    { network: "eip155:480", asset: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1", scheme: "exact" },
    { network: "eip155:4801", asset: "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88", scheme: "exact" },
    // Solana mainnet — Circle native USDC mint + EURC mint
    { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", scheme: "exact" },
    { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", scheme: "exact" },
  ] as const;

  if (
    config.coinbaseCdpApiKeyName !== undefined &&
    config.coinbaseCdpApiKeyName.length > 0 &&
    config.coinbaseCdpApiKeySecret !== undefined &&
    config.coinbaseCdpApiKeySecret.length > 0
  ) {
    const cdp = new CoinbaseCdpAdapter({
      apiKeyName: config.coinbaseCdpApiKeyName,
      apiKeySecret: config.coinbaseCdpApiKeySecret,
      capabilities: cdpCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
      estimatedFeeUsd: "0.001",
      monthlyHardCap: config.coinbaseCdpMonthlyHardCap,
      usageTracker: new RedisUsageTracker(redis, "cdp:usage"),
      ...(config.coinbaseCdpBaseUrl !== undefined &&
      config.coinbaseCdpBaseUrl.length > 0
        ? { baseUrl: config.coinbaseCdpBaseUrl }
        : {}),
    });
    await registry.register(cdp, {
      config: {
        baseUrl:
          config.coinbaseCdpBaseUrl ??
          "https://api.cdp.coinbase.com/platform/v2/x402",
        monthlyHardCap: config.coinbaseCdpMonthlyHardCap,
        estimatedFeeUsd: "0.001",
      },
      staticCapabilities: cdpCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
    });
  } else {
    logger.warn(
      "COINBASE_CDP_API_KEY_NAME / COINBASE_CDP_API_KEY_SECRET not set — skipping Coinbase CDP registration",
    );
  }

  // ---- PayAI (Solana + multi-EVM via facilitator.payai.network) -------
  // Free tier needs no credentials; we register the adapter by default
  // and gate registration on `payAiEnabled` so an operator can disable
  // PayAI without touching code.
  if (config.payAiEnabled) {
    // For (network, asset, scheme) pairs BOTH CDP and PayAI cover, the
    // gateway can fail over between them. Drift between the two adapter
    // configurations would break that, so keep the overlap entries
    // (Base / Polygon / Arbitrum / Base Sepolia, Solana mainnet mints)
    // bit-for-bit identical to the `cdpCaps` block above.
    //
    // PayAI-exclusive entries (Avalanche mainnet/Fuji, Arbitrum
    // Sepolia) are added in Phase 4 Block 1 Sub-task 2 — CDP's
    // /supported does not list them, so these routes go straight to
    // PayAI with no failover (see routing-config).
    const payAiCaps = [
      // ---- Solana mainnet (overlap with CDP) ---------------------------
      {
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        scheme: "exact",
      },
      {
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        asset: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
        scheme: "exact",
      },
      // ---- EVM overlap (CDP primary, PayAI failover) -------------------
      { network: "eip155:8453",  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", scheme: "exact" }, // Base mainnet USDC
      { network: "eip155:137",   asset: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", scheme: "exact" }, // Polygon USDC
      { network: "eip155:42161", asset: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", scheme: "exact" }, // Arbitrum USDC
      { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", scheme: "exact" }, // Base Sepolia USDC
      // ---- EVM PayAI-exclusive (CDP does not advertise these) ----------
      { network: "eip155:43114",  asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", scheme: "exact" }, // Avalanche C-Chain USDC
      { network: "eip155:43113",  asset: "0x5425890298aed601595a70AB815c96711a31Bc65", scheme: "exact" }, // Avalanche Fuji USDC
      { network: "eip155:421614", asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", scheme: "exact" }, // Arbitrum Sepolia USDC
    ] as const;
    const payAi = new PayAiAdapter({
      capabilities: payAiCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
      estimatedFeeUsd: "0.001",
      ...(config.payAiBaseUrl !== undefined && config.payAiBaseUrl.length > 0
        ? { baseUrl: config.payAiBaseUrl }
        : {}),
      ...(config.payAiApiKeyId !== undefined &&
      config.payAiApiKeyId.length > 0 &&
      config.payAiApiKeySecret !== undefined &&
      config.payAiApiKeySecret.length > 0
        ? { apiKeyId: config.payAiApiKeyId, apiKeySecret: config.payAiApiKeySecret }
        : {}),
    });
    await registry.register(payAi, {
      config: {
        baseUrl: config.payAiBaseUrl ?? "https://facilitator.payai.network",
        estimatedFeeUsd: "0.001",
      },
      staticCapabilities: payAiCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
    });
  } else {
    logger.warn("PAYAI_ENABLED=false — skipping PayAI registration");
  }

  // ---- Thirdweb Nexus x402 (Ethereum + Optimism + multi-EVM) -----------
  // Phase 4 Block 1 Sub-task 3 — adds eip155:1 (Ethereum) and eip155:10
  // (Optimism) as Thirdweb-only routes; design doc in
  // docs/design/non-cdp-evm-adapter.md (option A).
  //
  // Thirdweb's facilitator advertises ~20 EVM L1/L2s, but this
  // sub-task ships only the two networks we've verified on-chain
  // (Optimism + Ethereum mainnet, signer EIP-712 domain probed via
  // eth_call against publicnode + mainnet.optimism.io). The rest of
  // Thirdweb's footprint stays advertised at the adapter layer but is
  // not routed until each new network gets its own real-network smoke
  // and signer domain entry (follow-on sub-tasks).
  //
  // /supported + /health are open on the Nexus surface — registration
  // works without an API key (capability discovery + health checks
  // still function). Routing for /verify+/settle when no key is set
  // would 401 on the upstream, so operators who want live settlement
  // must set THIRDWEB_X402_API_KEY. We log a warning when it's missing
  // but keep the adapter registered so the gateway can still show
  // capabilities + health for the surface.
  if (config.thirdwebX402Enabled) {
    const thirdwebCaps = [
      // ---- Thirdweb-exclusive EVM mainnets (CDP + PayAI don't cover) ---
      // Sub-task 3 — Ethereum + Optimism.
      { network: "eip155:1",  asset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", scheme: "exact" }, // Ethereum mainnet USDC
      { network: "eip155:10", asset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", scheme: "exact" }, // Optimism mainnet USDC
      // Sub-task 5 expansion — 9 more EVM mainnets routed exclusively
      // through Thirdweb. USDC contract addresses match Thirdweb's
      // live /supported response (cached at
      // packages/adapters/thirdweb-x402/test-fixtures/thirdweb-supported.json)
      // and have been on-chain-verified via eth_call name()/version()/
      // decimals() against chain-specific public RPCs — see
      // packages/signers/evm/src/domains.ts header for the RPC list.
      { network: "eip155:50",    asset: "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1", scheme: "exact" }, // XDC USDC
      { network: "eip155:143",   asset: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", scheme: "exact" }, // Monad mainnet USDC
      { network: "eip155:146",   asset: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", scheme: "exact" }, // Sonic USDC
      { network: "eip155:1329",  asset: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392", scheme: "exact" }, // Sei mainnet USDC
      { network: "eip155:2741",  asset: "0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1", scheme: "exact" }, // Abstract Bridged USDC (Stargate)
      { network: "eip155:4689",  asset: "0xcdf79194c6c285077a58da47641d4dbe51f63542", scheme: "exact" }, // IoTeX Bridged USDC
      { network: "eip155:42220", asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", scheme: "exact" }, // Celo USDC
      { network: "eip155:57073", asset: "0x2D270e6886d130D724215A266106e6832161EAEd", scheme: "exact" }, // Ink USDC
      { network: "eip155:59144", asset: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", scheme: "exact" }, // Linea USDC
      // ---- Thirdweb-also-covered EVM (PayAI primary, Thirdweb failover) ---
      // These three networks are already in PayAI's static config and
      // routed PayAI-only; Thirdweb's /supported lists them too, so we
      // register them in the Thirdweb cap set as well. The routing
      // config (services/facilitator/src/routing-config.ts) is what
      // upgrades them from PayAI-only to PayAI-primary + Thirdweb-
      // failover. Asset addresses MUST match PayAI's caps verbatim so
      // both adapters advertise the same (network, asset, scheme).
      { network: "eip155:43114",  asset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", scheme: "exact" }, // Avalanche C-Chain USDC
      { network: "eip155:43113",  asset: "0x5425890298aed601595a70AB815c96711a31Bc65", scheme: "exact" }, // Avalanche Fuji USDC
      { network: "eip155:421614", asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", scheme: "exact" }, // Arbitrum Sepolia USDC
    ] as const;
    const thirdweb = new ThirdwebX402Adapter({
      capabilities: thirdwebCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
      estimatedFeeUsd: "0.001",
      ...(config.thirdwebX402BaseUrl !== undefined &&
      config.thirdwebX402BaseUrl.length > 0
        ? { baseUrl: config.thirdwebX402BaseUrl }
        : {}),
      ...(config.thirdwebX402ApiKey !== undefined &&
      config.thirdwebX402ApiKey.length > 0
        ? { apiKey: config.thirdwebX402ApiKey }
        : {}),
      ...(config.thirdwebX402AuthHeader !== undefined &&
      config.thirdwebX402AuthHeader.length > 0
        ? { authHeaderName: config.thirdwebX402AuthHeader }
        : {}),
    });
    await registry.register(thirdweb, {
      config: {
        baseUrl:
          config.thirdwebX402BaseUrl ?? "https://nexus-api.thirdweb.com",
        estimatedFeeUsd: "0.001",
      },
      staticCapabilities: thirdwebCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
    });
    if (
      config.thirdwebX402ApiKey === undefined ||
      config.thirdwebX402ApiKey.length === 0
    ) {
      logger.warn(
        "THIRDWEB_X402_API_KEY not set — Thirdweb adapter is registered (capability discovery + health works) but /verify and /settle will 401 until a key is configured",
      );
    }
  } else {
    logger.warn(
      "THIRDWEB_X402_ENABLED=false — skipping Thirdweb adapter registration",
    );
  }

  // ---- Binance x402 (BNB Chain, Sub-task 7) ---------------------------
  // The only adapter route to eip155:56 — CDP, PayAI, and Thirdweb
  // /supported responses don't list it. Binance's facilitator is a
  // Binance Pay product (HMAC-SHA512 merchant auth). As of 2026-05-29
  // there's no public endpoint we can hit unauthenticated; the adapter
  // is wired against the documented Binance Pay scheme + canonical
  // x402 v2 wire shape so the moment merchant credentials land in env,
  // routing works.
  //
  // Without API_KEY + API_SECRET set the adapter still registers (so
  // operators see it on the dashboard) but verify/settle calls throw
  // ProviderError("unauthorized") with a message pointing to the env
  // vars. Routing for eip155:56:exact is added below — gateway will
  // surface a clean 401 to the caller until keys arrive.
  if (config.binanceX402Enabled) {
    // BNB Chain mainnet stablecoins are 18 decimals — the canonical
    // BSC gotcha. Each entry below is the on-chain-verified
    // Binance-Peg address. USD1 and U await on-chain verification.
    const binanceCaps = [
      // USDC (Binance-Peg USD Coin) — 18 decimals, no version().
      // Settled via permit2-exact since BSC USDC doesn't implement
      // EIP-3009 standardly.
      {
        network: "eip155:56",
        asset: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
        scheme: "exact",
        assetTransferMethod: "permit2-exact" as const,
      },
      // USDT (Binance-Peg Tether USD) — 18 decimals.
      {
        network: "eip155:56",
        asset: "0x55d398326f99059fF775485246999027B3197955",
        scheme: "exact",
        assetTransferMethod: "permit2-exact" as const,
      },
    ];
    const binance = new BinanceX402Adapter({
      capabilities: binanceCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
        assetTransferMethod: c.assetTransferMethod,
      })),
      estimatedFeeUsd: "0.001",
      ...(config.binanceX402BaseUrl !== undefined &&
      config.binanceX402BaseUrl.length > 0
        ? { baseUrl: config.binanceX402BaseUrl }
        : {}),
      ...(config.binanceX402PathPrefix !== undefined &&
      config.binanceX402PathPrefix.length > 0
        ? { pathPrefix: config.binanceX402PathPrefix }
        : {}),
      ...(config.binanceX402ApiKey !== undefined &&
      config.binanceX402ApiKey.length > 0
        ? { apiKeyId: config.binanceX402ApiKey }
        : {}),
      ...(config.binanceX402ApiSecret !== undefined &&
      config.binanceX402ApiSecret.length > 0
        ? { apiSecret: config.binanceX402ApiSecret }
        : {}),
    });
    await registry.register(binance, {
      config: {
        baseUrl: config.binanceX402BaseUrl ?? "https://bpay.binanceapi.com",
        pathPrefix:
          config.binanceX402PathPrefix ?? "/binancepay/openapi/v1/x402",
        estimatedFeeUsd: "0.001",
      },
      staticCapabilities: binanceCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
    });
    if (
      config.binanceX402ApiKey === undefined ||
      config.binanceX402ApiKey.length === 0 ||
      config.binanceX402ApiSecret === undefined ||
      config.binanceX402ApiSecret.length === 0
    ) {
      logger.warn(
        "BINANCE_X402_API_KEY / BINANCE_X402_API_SECRET not set — Binance adapter registered but /verify and /settle will throw unauthorized until merchant credentials are configured",
      );
    }
  } else {
    logger.warn(
      "BINANCE_X402_ENABLED=false — skipping Binance adapter registration",
    );
  }

  // ---- BofAI x402 (TRON + BSC, Sub-task 8) ----------------------------
  // First non-EVM, non-Solana, non-Cosmos route in the gateway.
  // Open public facilitator (no auth required as of BofAI v0.6.0 —
  // their CHANGELOG: "clients no longer need API keys or secrets").
  // Default URL is the hosted facilitator; override BOFAI_X402_BASE_URL
  // to point at a self-hosted instance.
  //
  // TRON USDT is the largest USDT deployment by volume globally — this
  // adapter unlocks that audience. BSC overlap with Binance x402 lands
  // as Binance-primary + BofAI-failover in routing-config.
  //
  // Important: signing TRON paymentPayloads requires a TRON-native
  // signer the gateway doesn't yet ship (signer-tron is Phase 5). The
  // adapter is a thin forwarder — callers who produce TIP-712
  // signatures externally can settle through this route immediately;
  // first-party gateway-side TRON signing arrives in Phase 5.
  if (config.bofaiX402Enabled) {
    const bofaiCaps = [
      // TRON mainnet — USDT (Tether USD, 6 decimals), three schemes.
      { network: "tron:mainnet", asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", scheme: "exact" },
      { network: "tron:mainnet", asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", scheme: "exact_permit" },
      { network: "tron:mainnet", asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", scheme: "exact_gasfree" },
      // TRON Nile testnet — primary smoke target.
      { network: "tron:nile", asset: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", scheme: "exact" },
      { network: "tron:nile", asset: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", scheme: "exact_permit" },
      { network: "tron:nile", asset: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", scheme: "exact_gasfree" },
      // BSC mainnet — USDC + USDT, exact + exact_permit. Routing
      // promotes Binance to primary + BofAI to failover for these.
      { network: "eip155:56", asset: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", scheme: "exact" },
      { network: "eip155:56", asset: "0x55d398326f99059fF775485246999027B3197955", scheme: "exact" },
      { network: "eip155:56", asset: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", scheme: "exact_permit" },
      { network: "eip155:56", asset: "0x55d398326f99059fF775485246999027B3197955", scheme: "exact_permit" },
    ] as const;
    const bofai = new BofaiX402Adapter({
      capabilities: bofaiCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
      estimatedFeeUsd: "0.001",
      ...(config.bofaiX402BaseUrl !== undefined &&
      config.bofaiX402BaseUrl.length > 0
        ? { baseUrl: config.bofaiX402BaseUrl }
        : {}),
    });
    await registry.register(bofai, {
      config: {
        baseUrl: config.bofaiX402BaseUrl ?? "https://facilitator.bankofai.io",
        estimatedFeeUsd: "0.001",
      },
      staticCapabilities: bofaiCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
    });
  } else {
    logger.warn(
      "BOFAI_X402_ENABLED=false — skipping BofAI adapter registration",
    );
  }

  // ---- Stripe MPP (second protocol family, Sub-task 9) ----------------
  // MPP is a 402-protocol sibling to x402 with header-based wire
  // format. It does NOT register through ProviderRegistry — the
  // x402 ProviderAdapter interface and the new MppAdapter interface
  // are distinct (different wire-format, different verify/settle
  // semantics). The adapter is instantiated here so the package is
  // exercised at boot + the operator sees a clear status line, but
  // HTTP-facing /mpp/* routes wait on Phase 5 (Stripe's REST surface
  // for MPP verify/settle is not yet publicly documented).
  let mppStripeAdapter: MppAdapter | undefined;
  if (config.stripeMppEnabled) {
    mppStripeAdapter = new StripeMppAdapter({
      ...(config.stripeMppBaseUrl !== undefined &&
      config.stripeMppBaseUrl.length > 0
        ? { baseUrl: config.stripeMppBaseUrl }
        : {}),
      ...(config.stripeMppApiVersion !== undefined &&
      config.stripeMppApiVersion.length > 0
        ? { apiVersion: config.stripeMppApiVersion }
        : {}),
      ...(config.stripeMppSecretKey !== undefined &&
      config.stripeMppSecretKey.length > 0
        ? { secretKey: config.stripeMppSecretKey }
        : {}),
    });
    const caps = mppStripeAdapter.getCapabilities();
    logger.info(
      {
        capabilities: caps.length,
        secretKeyConfigured:
          config.stripeMppSecretKey !== undefined &&
          config.stripeMppSecretKey.length > 0,
      },
      "Stripe MPP adapter ready (Phase 4 — capability advertising + wire primitives; HTTP /mpp/* routes deferred to Phase 5)",
    );
    if (
      config.stripeMppSecretKey === undefined ||
      config.stripeMppSecretKey.length === 0
    ) {
      logger.warn(
        "STRIPE_MPP_SECRET_KEY not set — MPP adapter advertises capabilities but verify/settle will throw unauthorized until a sk_live_... / sk_test_... key is supplied",
      );
    }
  } else {
    logger.warn(
      "STRIPE_MPP_ENABLED=false — skipping MPP adapter registration",
    );
  }
  // mppStripeAdapter is intentionally NOT attached to ServerContext
  // — no HTTP routes consume it yet. Phase 5 will wire /mpp/* with
  // the adapter as a dependency. Hold the reference to keep the
  // package live and stop linters from flagging it.
  void mppStripeAdapter;

  // ---- t402-io universal USDT facilitator (Sub-task 10) -------------
  // Capability advertising via the open /supported endpoint. Verify
  // and settle gated on T402_IO_API_KEY (no public signup flow at
  // t402-io as of 2026-05-29; the adapter registers in capability
  // mode without a key). Caps deliberately scoped to chains where we
  // have a working signer:
  //   - EVM (signer-evm): mainnet USDT-friendly chains t402-io
  //     advertises. We don't try to advertise EVM chains where t402-io
  //     /supported doesn't list them.
  //   - Cosmos noble-1 MAINNET: first Cosmos mainnet route. cosmos-pay
  //     signer already exists.
  //   - Solana mainnet: signer-solana exists.
  // Non-EVM/Solana/Cosmos namespaces t402-io advertises (TON, NEAR,
  // Aptos, Tezos, Polkadot, Stacks, Stellar) are NOT registered here:
  // signers don't exist yet (Phase 5). Operators who want capability
  // visibility for them can pass extra entries via config.
  if (config.t402IoEnabled) {
    // Caps scoped to (network, scheme) tuples t402-io's live
    // /supported actually advertises AND where we have a working
    // signer. Schemes per namespace per the 2026-05-29 fixture:
    //   - eip155: `exact` for 1/10/137/8453/42161 USDT chains
    //   - cosmos: `exact-direct` (NOT plain `exact`)
    //   - solana: `exact`
    // BSC (56) and Avalanche (43114) only get `exact-legacy` from
    // t402-io as of 2026-05-29 — skipped here; we already route them
    // through Binance/PayAI/BofAI for `exact`. Non-EVM/Solana/Cosmos
    // namespaces t402-io advertises (TON, NEAR, Aptos, Tezos,
    // Polkadot, Stacks, Stellar) need signer-* packages that arrive
    // in Phase 5.
    const t402IoCaps = [
      // EVM USDT chains where t402-io advertises `exact` AND we
      // already have signer-evm support. Asset addresses are the
      // canonical Tether deployments per chain (from Sub-task 6 work).
      { network: "eip155:1",     asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7", scheme: "exact" }, // Ethereum USDT
      { network: "eip155:10",    asset: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", scheme: "exact" }, // Optimism USDT
      { network: "eip155:137",   asset: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", scheme: "exact" }, // Polygon USDT0
      { network: "eip155:8453",  asset: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", scheme: "exact" }, // Base USDT
      { network: "eip155:42161", asset: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", scheme: "exact" }, // Arbitrum USDT
      // Cosmos noble-1 MAINNET — first Cosmos mainnet route. Native
      // USDT on Noble (uusdt). t402-io advertises this as
      // `exact-direct`, not `exact` — the routing key reflects that.
      { network: "cosmos:noble-1", asset: "uusdt", scheme: "exact-direct" },
      // Solana mainnet USDT (SPL mint).
      { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", scheme: "exact" },
    ] as const;
    const t402io = new T402IoAdapter({
      capabilities: t402IoCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
      estimatedFeeUsd: "0.001",
      ...(config.t402IoBaseUrl !== undefined && config.t402IoBaseUrl.length > 0
        ? { baseUrl: config.t402IoBaseUrl }
        : {}),
      ...(config.t402IoApiKey !== undefined && config.t402IoApiKey.length > 0
        ? { apiKey: config.t402IoApiKey }
        : {}),
    });
    await registry.register(t402io, {
      config: {
        baseUrl: config.t402IoBaseUrl ?? "https://facilitator.t402.io",
        estimatedFeeUsd: "0.001",
      },
      staticCapabilities: t402IoCaps.map((c) => ({
        network: c.network,
        asset: c.asset,
        scheme: c.scheme,
      })),
    });
    if (
      config.t402IoApiKey === undefined ||
      config.t402IoApiKey.length === 0
    ) {
      logger.warn(
        "T402_IO_API_KEY not set — t402-io adapter registered (capability advertising + health works) but /verify and /settle throw unauthorized until a key is supplied (no public signup flow discovered as of 2026-05-29 — see packages/adapters/t402-io/README.md)",
      );
    }
  } else {
    logger.warn(
      "T402_IO_ENABLED=false — skipping t402-io adapter registration",
    );
  }

  // ---- Background crons ------------------------------------------------
  const orchLogger = {
    info: (m: string, c?: Record<string, unknown>) => logger.info(c ?? {}, m),
    warn: (m: string, c?: Record<string, unknown>) => logger.warn(c ?? {}, m),
    error: (m: string, c?: Record<string, unknown>) => logger.error(c ?? {}, m),
  };
  const discoveryCron = new CapabilityDiscoveryCron(
    registry,
    pool,
    config.capabilityDiscoveryIntervalMs,
    orchLogger,
  );
  const healthCron = new HealthCheckCron(
    registry,
    pool,
    config.healthCheckIntervalMs,
    orchLogger,
  );
  discoveryCron.start();
  healthCron.start();

  // Prometheus-format /metrics endpoint refresher — polls Postgres on
  // a tick and updates the prom-client Gauge registry. Phase 4 Block 1
  // Sub-task 4.
  const metricsRefresher = new MetricsRefresher({
    pool,
    intervalMs: config.metricsRefreshIntervalMs,
    logger: orchLogger,
  });
  const stopMetricsRefresher = metricsRefresher.start();

  // ---- ServerContext glue ---------------------------------------------
  const facilitatorRateLimiter = new FacilitatorRateLimiter({ redis });

  // Webhook delivery — BullMQ Queue (producer) + Worker (consumer).
  // The Queue gets attached to ServerContext so the settle handler
  // can enqueue fan-out jobs. The Worker runs in-process. BullMQ
  // requires `maxRetriesPerRequest: null` on the consumer connection
  // (the main `redis` above already sets it), but the docs steer
  // toward a dedicated connection per worker for isolation — we
  // construct a new one from the same URL so a slow worker doesn't
  // back-pressure the rate-limiter/cache path.
  const redisParsed = new URL(config.redisUrl);
  const bullConnection = {
    host: redisParsed.hostname,
    port: redisParsed.port.length > 0 ? Number(redisParsed.port) : 6379,
  };
  const webhookQueue = createWebhookQueue(bullConnection);
  const webhookWorker = createWebhookWorker({
    pool,
    connection: bullConnection,
    log: {
      info: (obj, msg) => logger.info(obj, msg),
      warn: (obj, msg) => logger.warn(obj, msg),
      error: (obj, msg) => logger.error(obj, msg),
    },
  });
  webhookWorker.on("ready", () =>
    logger.info({ component: "webhook-worker" }, "webhook worker ready"),
  );
  webhookWorker.on("error", (err) =>
    logger.error({ err: err.message }, "webhook worker error"),
  );

  const ctx: ServerContext = {
    config,
    registry,
    ledger,
    pool,
    facilitatorRateLimiter,
    webhookQueue,
    loadHealthSummaries: (providerIds) =>
      loadHealthSummariesFromDb(pool, providerIds),
    loadMetrics: () => loadMetricsFromDb(pool),
  };

  const app = await buildServer({ ctx, redis });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutdown initiated");
    discoveryCron.stop();
    healthCron.stop();
    await stopMetricsRefresher();
    await app.close();
    await webhookWorker.close();
    await webhookQueue.close();
    await pool.end();
    redis.disconnect();
    logger.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.apiHost, port: config.apiPort });
  logger.info(
    { host: config.apiHost, port: config.apiPort },
    "suverse-pay API listening",
  );
}

async function verifyAdminApiKey(
  pool: Pool,
  adminApiKey: string,
  logger: { warn: (msg: string) => void; error: (msg: string) => void },
): Promise<void> {
  try {
    const expected = sha256Hex(adminApiKey);
    const result = await pool.query<{ key_hash: string }>(
      `SELECT key_hash FROM api_keys WHERE id = $1 AND revoked_at IS NULL`,
      [ADMIN_API_KEY_ID],
    );
    if (result.rows.length === 0) {
      logger.warn(
        `admin api_key row '${ADMIN_API_KEY_ID}' not present in DB — run pnpm db:bootstrap`,
      );
      return;
    }
    if (result.rows[0]!.key_hash !== expected) {
      logger.error(
        `admin api_key row '${ADMIN_API_KEY_ID}' hash does not match ADMIN_API_KEY env — re-run pnpm db:bootstrap if you rotated the key`,
      );
    }
  } catch (err) {
    logger.warn(
      `could not verify admin api_key (db unreachable?): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function loadHealthSummariesFromDb(
  pool: Pool,
  providerIds: ReadonlyArray<string>,
): Promise<Map<string, ProviderHealthSummary>> {
  const out = new Map<string, ProviderHealthSummary>();
  if (providerIds.length === 0) return out;

  // Recent attempts (last 60s).
  const recent = await pool.query<{
    provider_id: string;
    attempts: string;
    failures: string;
  }>(
    `SELECT provider_id,
            COUNT(*)::text AS attempts,
            SUM(CASE WHEN outcome <> 'success' THEN 1 ELSE 0 END)::text AS failures
       FROM payment_attempts
      WHERE started_at > NOW() - INTERVAL '60 seconds'
        AND provider_id = ANY($1)
      GROUP BY provider_id`,
    [providerIds],
  );

  // 7-day rolling avg latency + success rate.
  const rolling = await pool.query<{
    provider_id: string;
    avg_latency_ms: string | null;
    success_rate: string | null;
  }>(
    `SELECT provider_id,
            AVG(latency_ms)::text AS avg_latency_ms,
            (SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END)::numeric
              / NULLIF(COUNT(*), 0))::text AS success_rate
       FROM payment_attempts
      WHERE started_at > NOW() - INTERVAL '7 days'
        AND provider_id = ANY($1)
      GROUP BY provider_id`,
    [providerIds],
  );

  // Latest provider_health_checks row per provider.
  const lastCheck = await pool.query<{
    provider_id: string;
    status: string;
    checked_at: Date;
  }>(
    `SELECT DISTINCT ON (provider_id) provider_id, status, checked_at
       FROM provider_health_checks
      WHERE provider_id = ANY($1)
      ORDER BY provider_id, checked_at DESC`,
    [providerIds],
  );

  const recentBy = new Map(recent.rows.map((r) => [r.provider_id, r]));
  const rollingBy = new Map(rolling.rows.map((r) => [r.provider_id, r]));
  const checkBy = new Map(lastCheck.rows.map((r) => [r.provider_id, r]));

  for (const id of providerIds) {
    const r = recentBy.get(id);
    const ro = rollingBy.get(id);
    const c = checkBy.get(id);
    out.set(id, {
      providerId: id,
      recentAttempts: r ? Number(r.attempts) : 0,
      recentFailures: r ? Number(r.failures) : 0,
      lastCheck: c
        ? {
            status: c.status as "healthy" | "degraded" | "down",
            checkedAt: c.checked_at,
          }
        : null,
      successRate7d: ro ? Number(ro.success_rate ?? 1) : 1,
      avgLatencyMs7d: ro ? Number(ro.avg_latency_ms ?? 0) : 0,
    });
  }
  return out;
}

async function loadMetricsFromDb(pool: Pool): Promise<MetricsSummary> {
  const [byStatus, byProvider, facByKey, facByNetwork, facByAdapter, failoverCount] =
    await Promise.all([
      pool.query<{ status: string; n: string }>(
        `SELECT status, COUNT(*)::text AS n FROM payments GROUP BY status`,
      ),
      pool.query<{
        provider_id: string;
        attempts: string;
        successes: string;
        failures: string;
        avg_latency_ms: string | null;
      }>(
        `SELECT provider_id,
                COUNT(*)::text AS attempts,
                SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END)::text AS successes,
                SUM(CASE WHEN outcome <> 'success' AND outcome <> 'pending' THEN 1 ELSE 0 END)::text AS failures,
                AVG(latency_ms)::text AS avg_latency_ms
           FROM payment_attempts
          WHERE started_at > NOW() - INTERVAL '24 hours'
          GROUP BY provider_id`,
      ),
      pool.query<{
        resource_key_id: string;
        label: string;
        settled: string;
        failed: string;
      }>(
        `SELECT fp.resource_key_id,
                rak.label,
                SUM(CASE WHEN fp.status = 'settled' THEN 1 ELSE 0 END)::text AS settled,
                SUM(CASE WHEN fp.status = 'failed'  THEN 1 ELSE 0 END)::text AS failed
           FROM facilitator_payments fp
           JOIN resource_api_keys    rak ON rak.id = fp.resource_key_id
          WHERE fp.created_at > NOW() - INTERVAL '24 hours'
          GROUP BY fp.resource_key_id, rak.label`,
      ),
      pool.query<{ network: string; settled: string; failed: string }>(
        `SELECT network,
                SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END)::text AS settled,
                SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END)::text AS failed
           FROM facilitator_payments
          WHERE created_at > NOW() - INTERVAL '24 hours'
          GROUP BY network`,
      ),
      pool.query<{ adapter_used: string; settled: string; failed: string }>(
        `SELECT adapter_used,
                SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END)::text AS settled,
                SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END)::text AS failed
           FROM facilitator_payments
          WHERE created_at > NOW() - INTERVAL '24 hours' AND adapter_used IS NOT NULL
          GROUP BY adapter_used`,
      ),
      pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM facilitator_failover_events
          WHERE created_at > NOW() - INTERVAL '24 hours'`,
      ),
    ]);
  const status: Record<string, number> = {};
  let total = 0;
  for (const row of byStatus.rows) {
    const n = Number(row.n);
    status[row.status] = n;
    total += n;
  }
  const settled = status.settled ?? 0;
  const failed = status.failed ?? 0;
  const pending = status.pending ?? 0;
  return {
    totals: {
      payments: total,
      settled,
      failed,
      pending,
      successRate: total === 0 ? 0 : settled / total,
    },
    providers: byProvider.rows.map((r) => ({
      providerId: r.provider_id,
      attempts: Number(r.attempts),
      successes: Number(r.successes),
      failures: Number(r.failures),
      avgLatencyMs: r.avg_latency_ms !== null ? Number(r.avg_latency_ms) : null,
    })),
    facilitator: {
      paymentsByResourceKey: facByKey.rows.map((r) => ({
        resourceKeyId: r.resource_key_id,
        label: r.label,
        settled: Number(r.settled),
        failed: Number(r.failed),
      })),
      paymentsByNetwork: facByNetwork.rows.map((r) => ({
        network: r.network,
        settled: Number(r.settled),
        failed: Number(r.failed),
      })),
      adapterSelections: facByAdapter.rows.map((r) => ({
        adapter: r.adapter_used,
        settled: Number(r.settled),
        failed: Number(r.failed),
      })),
      failoverEvents: Number(failoverCount.rows[0]?.n ?? "0"),
    },
    generatedAt: new Date().toISOString(),
  };
}

main().catch((err: unknown) => {
  console.error("fatal during bootstrap", err);
  process.exit(1);
});
