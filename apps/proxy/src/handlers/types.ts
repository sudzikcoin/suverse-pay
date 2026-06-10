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
 * No logger, no facilitator client. A handler that needs an HTTP
 * outcall reaches it through `fetchImpl`; a handler that aggregates
 * over our own Postgres tables (e.g. crypto_market_pulse over
 * sm_trades) reaches the DB through the optional `db` querier — both
 * are injection seams used by tests.
 */

/**
 * Minimal query surface a handler may use. Structurally satisfied by
 * `pg.Pool` / `pg.PoolClient`; tests pass a stub returning canned rows.
 */
export interface DbQuerier {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface InternalHandlerInput {
  /** Original raw request body (already validated for method match). */
  body: Buffer | null;
  /** Upper-case HTTP method. */
  method: string;
  /** Allow tests to inject a stub fetch. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Read-only-ish access to the proxy's Postgres pool. Only wired for
   * handlers that aggregate over local tables; absent for the
   * fetch-only majority.
   */
  db?: DbQuerier;
  /**
   * Result computed by this handler's preflight (see
   * `InternalHandlerPreflight`) on the SAME request, threaded through
   * so the handler doesn't recompute the critical sources it already
   * proved healthy moments before settlement.
   */
  preflightData?: unknown;
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

/**
 * Optional pre-SETTLEMENT health gate. Unlike validators (cheap,
 * synchronous, shape-only), a preflight MAY do network/DB I/O: it
 * runs only when the request carries a payment header, AFTER the
 * validator but BEFORE `runProtocol()` settles the payment on-chain.
 *
 * Purpose: fail-closed endpoints. If the handler cannot possibly
 * produce its product (a critical upstream or table is down), the
 * preflight returns `proceed: false` and the buyer gets that response
 * WITHOUT being charged. Returning `proceed: true` may carry `data`,
 * which the dispatcher threads into the handler as
 * `input.preflightData` so the expensive critical-source work isn't
 * done twice.
 *
 * A preflight that throws is treated as `proceed: false` with a 503 —
 * never settle on an unproven critical path.
 */
export type InternalHandlerPreflight = (
  input: InternalHandlerInput,
) => Promise<
  | { proceed: true; data?: unknown }
  | { proceed: false; status: number; body: unknown }
>;
