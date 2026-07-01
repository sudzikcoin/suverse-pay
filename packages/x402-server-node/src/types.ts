/**
 * Accepted payment requirement that the seller is willing to honour.
 * One entry per (network, asset) the resource server accepts.
 *
 * Field names mirror the x402 v2 wire format: any field marked
 * REQUIRED here will appear verbatim in the 402 challenge body that
 * the middleware emits, and the matching `X-Payment` payload from
 * the client must reference the same `network` + `payTo` to be
 * accepted.
 */
export interface AcceptedPayment {
  /** Payment scheme. v1 of this middleware only supports "exact". */
  readonly scheme: "exact";
  /** CAIP-2 network identifier, e.g. "eip155:8453", "solana:mainnet". */
  readonly network: string;
  /** On-chain asset identifier (token contract address or mint). */
  readonly asset: string;
  /** Address that should receive the settled payment. */
  readonly payTo: string;
  /**
   * Maximum amount the seller will charge per call, in the asset's
   * atomic units (e.g. USDC has 6 decimals → 100000 = $0.10).
   * String to preserve uint256 precision.
   */
  readonly maxAmountRequired: string;
  /**
   * Optional per-network amount label override for the 402 challenge.
   * Most sellers leave this off; it exists for sellers that want to
   * show different prices per network (rare in v1).
   */
  readonly description?: string;
  /**
   * Optional per-network extension data, forwarded verbatim into the
   * 402 challenge's per-accept `extra` field. Used by signing clients
   * that need network-specific context. For EVM `exact`, ecosystem
   * v2 clients (e.g. `@x402/evm`) require the EIP-712 domain to
   * construct the `transferWithAuthorization` typed-data signature:
   *
   *   extra: { name: "USD Coin", version: "2" }     // Circle USDC
   *
   * For Solana, Cosmos, TRON `exact`, no `extra` is needed today.
   */
  readonly extra?: Record<string, unknown>;
}

/**
 * Options passed to `createX402Middleware()`. The same shape works
 * for the Express and Fastify adapters.
 */
export interface MiddlewareOptions {
  /**
   * suverse-pay resource API key (sup_live_<32 base62>). Sent as a
   * Bearer token to the facilitator's /facilitator/settle endpoint.
   */
  readonly apiKey: string;
  /**
   * Base URL of the suverse-pay facilitator. Trailing slash is OK
   * but not required.
   *
   * Example: "https://facilitator.suverse.io"
   */
  readonly facilitator: string;
  /** One or more accepted payment definitions. Must be non-empty. */
  readonly acceptedPayments: readonly AcceptedPayment[];
  /**
   * Optional public description that appears in the 402 challenge
   * body. Surfaces in agent UIs that list paid endpoints.
   */
  readonly description?: string;
  /**
   * x402 protocol version to advertise in the challenge body.
   * Default: 2. Set to 1 only if you must talk to a legacy client.
   */
  readonly x402Version?: 1 | 2;
  /**
   * If false, the middleware only calls /facilitator/verify (off-chain
   * signature check) and does NOT settle. Use this to gate access
   * with a one-time signature without pulling funds. Default: true.
   */
  readonly settle?: boolean;
  /**
   * Optional fetch implementation injection (for tests + custom TLS).
   * Defaults to the global `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Optional logger. Default: silent (nothing logged). Pass your
   * pino/winston logger if you want middleware events on stderr.
   */
  readonly logger?: Pick<Console, "warn" | "error" | "info">;
  /**
   * Disable the auto-discovery of facilitator-published per-kind
   * `extra` data (added in v0.3.0). When `true`, the middleware
   * builds 402 challenges using ONLY the `extra` you set on each
   * `acceptedPayments` entry — the same behavior as v0.2.0.
   *
   * Defaults to `false` (auto-discovery on). Set to `true` if:
   * - you don't want the middleware reaching out to the facilitator
   *   at boot (e.g. tight network egress policy),
   * - you maintain your own `extra` values and want them to be the
   *   sole source of truth, or
   * - you're running against a facilitator that doesn't implement
   *   the suverse-pay PR-A /supported.extra surface yet.
   *
   * Note: even with auto-discovery on, seller-provided `extra` wins
   * over facilitator-published values per key, so you can mix
   * partial overrides with auto-fetched defaults.
   */
  readonly disableAutoDiscover?: boolean;
  /**
   * TTL for the in-process facilitator `/supported` cache, in
   * milliseconds. Default: 3,600,000 (1 hour). Lower it to react
   * faster to facilitator config changes; raise it to reduce the
   * number of `/supported` round-trips on long-lived processes.
   * Ignored when `disableAutoDiscover` is true.
   */
  readonly facilitatorExtrasCacheTtlMs?: number;
  /**
   * Optional top-level extensions block attached to every 402
   * challenge body. Forwarded verbatim — the middleware does NOT
   * validate the inner shape. Use this to advertise discovery
   * metadata that ecosystem crawlers read off the live 402, such
   * as the Coinbase Bazaar `extensions.bazaar` block built with
   * `@x402/extensions/bazaar`'s `declareDiscoveryExtension()`.
   *
   * Example:
   *   import { declareDiscoveryExtension }
   *     from "@x402/extensions/bazaar";
   *   const extensions = declareDiscoveryExtension({
   *     method: "GET",
   *     output: { example: { foo: "bar" } },
   *   });
   *
   * Per-route content: if you have multiple endpoints behind one
   * middleware, build the block per request and pass it through
   * a thin wrapper rather than baking it into a long-lived options
   * object.
   */
  readonly extensions?: Record<string, unknown>;
  /**
   * Bounded retry-with-backoff for TRANSIENT facilitator /verify and
   * /settle failures. A single facilitator hiccup (5xx, unreachable,
   * non-JSON gateway garbage, or a transient `invalid_request` /
   * `facilitator_error` such as the Jun-2026 CDP settlement outage)
   * would otherwise drop the buyer straight to a fresh 402 with no
   * second attempt — turning an intermittent upstream blip into a
   * total failure for scheduled pollers.
   *
   * Safety: every attempt reuses the SAME `Idempotency-Key`, so a
   * settle that actually broadcast on-chain but whose response was
   * lost is de-duplicated by the facilitator and never double-charges.
   * A genuinely-invalid signature is a 200 `isValid:false` verdict
   * (not an HTTP error) and is NOT retried.
   *
   * Defaults: `attempts: 3`, `baseDelayMs: 200` (exponential +
   * full-jitter). Set `attempts: 1` to disable, or `baseDelayMs: 0`
   * in tests to remove real sleeps.
   */
  readonly facilitatorRetry?: {
    /** Total attempts including the first. Default 3. Min 1. */
    readonly attempts?: number;
    /** Base backoff in ms; exponential with full jitter. Default 200. */
    readonly baseDelayMs?: number;
  };
}

/**
 * Metadata attached to the request object after a successful settle
 * (or verify, if `settle: false`). The Express adapter stuffs this
 * onto `req.x402Payment`; the Fastify adapter onto
 * `request.x402Payment`. Use TypeScript module augmentation to type
 * it on your own request type.
 */
export interface PaymentReceipt {
  /**
   * Wallet that signed the payment (extracted from the verified
   * payload). Present whenever the facilitator verified the
   * signature, regardless of settle outcome.
   */
  readonly payer: string;
  /**
   * Which of your declared `acceptedPayments` the client paid against.
   */
  readonly network: string;
  /** Asset id (token contract / mint) actually paid in. */
  readonly asset: string;
  /** Atomic amount paid, as a string (uint256-safe). */
  readonly amount: string;
  /**
   * On-chain transaction id if the middleware ran `/settle`.
   * `null` if `settle: false` or if the facilitator returned
   * without broadcasting (some adapters batch).
   */
  readonly txHash: string | null;
  /**
   * The full settle response from the facilitator, kept verbatim
   * so you can surface adapter-specific fields without forcing the
   * middleware to flatten them. The shape varies by adapter; do
   * not depend on any non-standard field.
   */
  readonly raw: Record<string, unknown>;
}

/**
 * Structured error returned by the middleware before dispatching
 * to the seller's handler. The middleware writes the matching
 * HTTP response itself (402 or 4xx); this interface exists so an
 * application-level error handler can recognise the type.
 */
export class X402Error extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "X402Error";
    this.code = code;
    this.statusCode = statusCode;
  }
}
