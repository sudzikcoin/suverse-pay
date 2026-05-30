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
