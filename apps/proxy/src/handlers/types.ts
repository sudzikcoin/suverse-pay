/**
 * Shared contract for in-process "internal" endpoint handlers.
 *
 * An internal handler replaces the upstream HTTP fetch entirely: the
 * proxy still runs the x402 protocol (challenge → settle), then —
 * instead of forwarding the buyer's request to `original_url` — it
 * invokes the handler registered under `seller_proxy_configs.internal_handler`
 * (migration 025) and serializes whatever the handler returns.
 *
 * The contract is deliberately tiny — handlers receive only the
 * request body + method, and return a status + JSON-serializable body.
 * No DB pool, no logger, no facilitator client. A handler that needs
 * an HTTP outcall reaches it through `fetchImpl` (injection seam used
 * by tests).
 */

export interface InternalHandlerInput {
  /** Original raw request body (already validated for method match). */
  body: Buffer | null;
  /** Upper-case HTTP method. */
  method: string;
  /** Allow tests to inject a stub fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface InternalHandlerResult {
  status: number;
  /** JSON-serializable. The proxy stringifies + sets content-type. */
  body: unknown;
}

export type InternalHandler = (
  input: InternalHandlerInput,
) => Promise<InternalHandlerResult>;

/**
 * Optional pre-payment body validator. Runs BEFORE x402 challenge or
 * settlement so a buyer who sent garbage gets a clean 400 — they
 * never reach the 402 prompt, never pay for a call that was always
 * going to fail server-side. Returns null when the body is fine,
 * otherwise an `InternalHandlerResult` whose `status` and `body` are
 * served to the buyer verbatim.
 *
 * Validators are intentionally cheap: argument-shape checks, base
 * encodings, length plausibility. They MUST NOT do network I/O — the
 * proxy is on the hot path before the buyer has even paid. Heavier
 * validation belongs in the handler itself after payment.
 */
export type InternalHandlerValidator = (
  body: Buffer | null,
  method: string,
) => InternalHandlerResult | null;
