/**
 * SuVerse Swap Bazaar publishing endpoints.
 *
 * The Coinbase Developer Platform `/discovery/{merchant,resources}`
 * index is populated inline by the /verify + /settle envelope that
 * a CDP-routed facilitator receives. The envelope must carry
 * `paymentPayload.extensions.bazaar`, the indexed URL must not
 * include hex-looking session segments, and at least one real
 * paid settle to that exact URL is required to wake the indexer.
 *
 * Our customer-facing swap endpoints don't fit cleanly:
 *
 *   - /v1/swap/solana/quote is free, so no settle ever touches it.
 *   - /v1/swap/solana/execute/:quoteId has a per-quote URL — every
 *     buyer hits a distinct path, so CDP would index transient
 *     URLs nobody else can use.
 *
 * Workaround: a stable, low-cost "publish" endpoint per chain whose
 * sole purpose is to (a) advertise the swap service in its 402
 * `extensions.bazaar` block and (b) accept one real $0.001 USDC
 * settle so CDP's crawler picks it up. After settle the endpoint
 * returns a small manifest pointing AI agents at the real /quote
 * route to use.
 *
 * Registered URLs:
 *
 *   POST /v1/swap/solana/__publish    — x402 $0.001 USDC on Solana
 *   POST /v1/swap/base/__publish      — x402 $0.001 USDC on Base
 *
 * Both routes are guarded by env: register only when
 * SWAP_PUBLISH_ENABLED is "true". Defaults to disabled so we don't
 * expose them in production by default — flip the flag, do the
 * indexing settle, then flip it back.
 *
 * Description fields stay ASCII-only and ≤ 320 chars per the CDP
 * /verify schema quirks we recorded after the
 * suverse-solana-tx-simulator em-dash incident.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { runProtocol } from "@suverselabs/x402-server";
import type {
  AcceptedPayment,
  MiddlewareOptions,
} from "@suverselabs/x402-server";
import {
  USDC_MINT as SOLANA_USDC_MINT,
  SOLANA_CAIP2,
  type SwapSignerConfig,
} from "./swap.js";
import {
  USDC_BASE,
  BASE_CAIP2,
  type BaseSwapSignerConfig,
} from "./swap-base.js";

// --------------------------------------------------------- env gate ----

export function publishEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["SWAP_PUBLISH_ENABLED"] === "true";
}

// --------------------------------------------------------- payments ----

/** Indexing fee. $0.001 in 6-decimal USDC = 1000 atomic units. */
const PUBLISH_AMOUNT_ATOMIC = "1000";

// --------------------------------------------------------- bazaar block ----

const SOLANA_DESCRIPTION =
  "SuVerse Solana token swap. Step 1 POST /v1/swap/solana/quote with " +
  "input_mint USDC, output_mint, input_amount, slippage_bps. Step 2 " +
  "POST /v1/swap/solana/execute/<quote_id> with x402 payment for the " +
  "total_cost returned by step 1. Output SPL tokens land on the paying " +
  "wallet. Routed by Jupiter across 30 plus Solana DEXs. 1 percent fee.";

const BASE_DESCRIPTION =
  "SuVerse Base ERC20 swap. Step 1 POST /v1/swap/base/quote with " +
  "input_token USDC, output_token, input_amount, slippage_bps. Step 2 " +
  "POST /v1/swap/base/execute/<quote_id> with x402 payment for the " +
  "total_cost returned by step 1. Output tokens land on the paying " +
  "wallet. Routed by LiFi across Uniswap V3, Aerodrome, SushiSwap. " +
  "1 percent fee.";

const SOLANA_QUOTE_INPUT_EXAMPLE: Record<string, unknown> = {
  input_mint: SOLANA_USDC_MINT,
  output_mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  input_amount: "1000000",
  slippage_bps: 100,
};

const SOLANA_PUBLISH_OUTPUT_EXAMPLE: Record<string, unknown> = {
  service: "suverse-solana-swap",
  quote_endpoint: "https://proxy.suverse.io/v1/swap/solana/quote",
  execute_endpoint:
    "https://proxy.suverse.io/v1/swap/solana/execute/{quote_id}",
  network: SOLANA_CAIP2,
  fee_bps: 100,
};

const BASE_QUOTE_INPUT_EXAMPLE: Record<string, unknown> = {
  input_token: USDC_BASE,
  output_token: "0x4200000000000000000000000000000000000006",
  input_amount: "1000000",
  slippage_bps: 100,
};

const BASE_PUBLISH_OUTPUT_EXAMPLE: Record<string, unknown> = {
  service: "suverse-base-swap",
  quote_endpoint: "https://proxy.suverse.io/v1/swap/base/quote",
  execute_endpoint:
    "https://proxy.suverse.io/v1/swap/base/execute/{quote_id}",
  network: BASE_CAIP2,
  fee_bps: 100,
};

function bazaarFor(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
): Record<string, unknown> {
  return declareDiscoveryExtension({
    method: "POST",
    bodyType: "json" as const,
    input,
    output: { example: output },
  } as Parameters<typeof declareDiscoveryExtension>[0]) as Record<
    string,
    unknown
  >;
}

// --------------------------------------------------------- routes ----

export interface SwapPublishDeps {
  facilitatorUrl: string;
  facilitatorApiKey: string;
  publicBaseUrl: string;
  /** Solana swap signer (payTo for the Solana publish settle). */
  swapSigner?: SwapSignerConfig;
  /** Base swap signer (payTo for the Base publish settle). */
  baseSwapSigner?: BaseSwapSignerConfig;
  fetchImpl?: typeof fetch;
}

export function registerSwapPublishRoutes(
  app: FastifyInstance,
  deps: SwapPublishDeps,
): void {
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (deps.swapSigner) {
    const resourceUrl = `${deps.publicBaseUrl}/v1/swap/solana/__publish`;
    const bazaar = bazaarFor(
      SOLANA_QUOTE_INPUT_EXAMPLE,
      SOLANA_PUBLISH_OUTPUT_EXAMPLE,
    );
    const accepted: AcceptedPayment[] = [
      {
        scheme: "exact",
        network: SOLANA_CAIP2,
        asset: SOLANA_USDC_MINT,
        payTo: deps.swapSigner.address,
        maxAmountRequired: PUBLISH_AMOUNT_ATOMIC,
      },
    ];

    app.route({
      method: "POST",
      url: "/v1/swap/solana/__publish",
      handler: async (req, reply) => {
        const headers = req.headers as Record<
          string,
          string | string[] | undefined
        >;
        const paymentHeader =
          pickHeader(headers, "payment-signature") ??
          pickHeader(headers, "x-payment");
        const idempotencyKey =
          pickHeader(headers, "idempotency-key") ??
          `publish-solana-${randomUUID()}`;

        const opts: MiddlewareOptions = {
          apiKey: deps.facilitatorApiKey,
          facilitator: deps.facilitatorUrl,
          acceptedPayments: accepted,
          description: SOLANA_DESCRIPTION,
          x402Version: 2,
          extensions: bazaar,
          settle: true,
          fetchImpl,
          logger: req.log as unknown as MiddlewareOptions["logger"],
        };

        const protocol = await runProtocol({
          opts,
          resourceUrl,
          paymentHeader,
          idempotencyKey,
        });
        if (protocol.kind !== "accepted") {
          return reply
            .code(protocol.status)
            .header("content-type", "application/json")
            .header("cache-control", "no-store")
            .header(
              "payment-required",
              Buffer.from(JSON.stringify(protocol.body)).toString("base64"),
            )
            .send(protocol.body);
        }
        const receipt = protocol.receipt;
        const paymentResponse = Buffer.from(
          JSON.stringify({
            success: true,
            transaction: receipt.txHash ?? "",
            network: receipt.network,
            payer: receipt.payer,
            amount: receipt.amount,
          }),
        ).toString("base64");
        return reply
          .code(200)
          .header("payment-response", paymentResponse)
          .header("x-payment-response", paymentResponse)
          .header(
            "access-control-expose-headers",
            "PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
          )
          .send(SOLANA_PUBLISH_OUTPUT_EXAMPLE);
      },
    });
  }

  if (deps.baseSwapSigner) {
    const resourceUrl = `${deps.publicBaseUrl}/v1/swap/base/__publish`;
    const bazaar = bazaarFor(
      BASE_QUOTE_INPUT_EXAMPLE,
      BASE_PUBLISH_OUTPUT_EXAMPLE,
    );
    const accepted: AcceptedPayment[] = [
      {
        scheme: "exact",
        network: BASE_CAIP2,
        asset: USDC_BASE,
        payTo: deps.baseSwapSigner.address,
        maxAmountRequired: PUBLISH_AMOUNT_ATOMIC,
        extra: { name: "USD Coin", version: "2" },
      },
    ];

    app.route({
      method: "POST",
      url: "/v1/swap/base/__publish",
      handler: async (req, reply) => {
        const headers = req.headers as Record<
          string,
          string | string[] | undefined
        >;
        const paymentHeader =
          pickHeader(headers, "payment-signature") ??
          pickHeader(headers, "x-payment");
        const idempotencyKey =
          pickHeader(headers, "idempotency-key") ??
          `publish-base-${randomUUID()}`;

        const opts: MiddlewareOptions = {
          apiKey: deps.facilitatorApiKey,
          facilitator: deps.facilitatorUrl,
          acceptedPayments: accepted,
          description: BASE_DESCRIPTION,
          x402Version: 2,
          extensions: bazaar,
          settle: true,
          fetchImpl,
          logger: req.log as unknown as MiddlewareOptions["logger"],
        };

        const protocol = await runProtocol({
          opts,
          resourceUrl,
          paymentHeader,
          idempotencyKey,
        });
        if (protocol.kind !== "accepted") {
          return reply
            .code(protocol.status)
            .header("content-type", "application/json")
            .header("cache-control", "no-store")
            .header(
              "payment-required",
              Buffer.from(JSON.stringify(protocol.body)).toString("base64"),
            )
            .send(protocol.body);
        }
        const receipt = protocol.receipt;
        const paymentResponse = Buffer.from(
          JSON.stringify({
            success: true,
            transaction: receipt.txHash ?? "",
            network: receipt.network,
            payer: receipt.payer,
            amount: receipt.amount,
          }),
        ).toString("base64");
        return reply
          .code(200)
          .header("payment-response", paymentResponse)
          .header("x-payment-response", paymentResponse)
          .header(
            "access-control-expose-headers",
            "PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
          )
          .send(BASE_PUBLISH_OUTPUT_EXAMPLE);
      },
    });
  }
}

function pickHeader(
  h: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = h[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}
