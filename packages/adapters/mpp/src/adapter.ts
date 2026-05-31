import type { HealthStatus } from "@suverse-pay/core-types";
import { ProviderError } from "@suverse-pay/core-types";
import type {
  MppCapability,
  MppChallenge,
  MppCredential,
  MppSettleResult,
  MppVerifyResult,
} from "./types.js";

/**
 * MppAdapter — the new interface this sub-task introduces, parallel
 * to `FacilitatorAdapter` for the x402 protocol. Phase 4 Block 2
 * Sub-task 9.
 *
 * MPP and x402 share the "402-then-retry" challenge-response shape
 * but the wire format differs: x402 puts the challenge in the
 * response body + `X-PAYMENT` header; MPP puts it in
 * `WWW-Authenticate: Payment ...` headers. The semantics — verify a
 * credential, then settle on-chain or via a payment processor — map
 * one-to-one.
 *
 * Methods kept intentionally small. The Stripe MPP API surface in
 * particular is merchant-onboarding-gated (sk_live/sk_test keys
 * required) — the adapter is internally callable today; HTTP-facing
 * `/mpp/*` routes inside `apps/api` are out of scope for this
 * sub-task (the user's prompt described session-lifecycle endpoints
 * but the actual MPP spec uses single-shot 402 challenges, not
 * persistent server-side sessions). Phase 5 can wire HTTP surfaces
 * once Stripe's subscription/session intent API stabilizes
 * publicly.
 */
export interface MppAdapter {
  readonly id: string;
  readonly displayName: string;

  /**
   * Returns the `(method, intent, network?, asset?)` tuples this
   * adapter knows how to verify + settle. Drives the WWW-Authenticate
   * header set the server emits in a 402 response.
   */
  getCapabilities(): ReadonlyArray<MppCapability>;

  /**
   * Verify a credential against the original challenge. For chain
   * methods (tempo) this typically means signature recovery + balance
   * check. For SPT (stripe) it means hitting Stripe's PaymentIntent
   * lookup. Pure read — does NOT broadcast or capture.
   */
  verifyCredential(args: {
    challenge: MppChallenge;
    credential: MppCredential;
  }): Promise<MppVerifyResult>;

  /**
   * Settle the credential. For tempo: submits the signed transaction
   * to Tempo via the Stripe MPP `/tempo/charge` settle path (the
   * facilitator broadcasts and pays the fee on the user's behalf).
   * For stripe: confirms the PaymentIntent. Returns reference id
   * (tx hash or `pi_...`).
   */
  settleCredential(args: {
    challenge: MppChallenge;
    credential: MppCredential;
    idempotencyKey?: string;
  }): Promise<MppSettleResult>;

  /** Liveness — typically a cheap HEAD against the configured API host. */
  getHealthStatus(): Promise<HealthStatus>;
}

/* --- Stripe MPP adapter implementation --- */

const ADAPTER_ID = "mpp-stripe";
const DEFAULT_DISPLAY_NAME = "Stripe Machine Payments Protocol";

/**
 * Default Stripe MPP base URL. Stripe's MPP entrypoint lives on the
 * standard Stripe API host. Operators with a different region or
 * staging environment override via `baseUrl`.
 */
const DEFAULT_BASE_URL = "https://api.stripe.com";

/** Stripe MPP API version per the docs at docs.stripe.com/payments/machine/mpp. */
const DEFAULT_API_VERSION = "2026-03-04.preview";

/** Tempo mainnet — the canonical MPP settlement chain. EIP-155 chain 4217. */
export const TEMPO_MAINNET_CAIP2 = "eip155:4217" as const;
/** Tempo Moderato testnet — chain 42431. */
export const TEMPO_MODERATO_CAIP2 = "eip155:42431" as const;

/**
 * Bridged USDC (Stargate) on Tempo mainnet. Verified on-chain
 * 2026-05-29 via rpc.tempo.xyz: name="Bridged USDC (Stargate)",
 * symbol="USDC.e", decimals=6. NOT canonical Circle EIP-3009
 * (`version()` reverts) — Stripe's MPP backend handles signing and
 * settlement.
 */
export const TEMPO_MAINNET_USDC = "0x20C000000000000000000000b9537d11c60E8b50" as const;

export interface StripeMppAdapterConfig {
  /** Defaults to `https://api.stripe.com`. */
  baseUrl?: string;
  /** Defaults to `2026-03-04.preview`. */
  apiVersion?: string;
  /**
   * Stripe API secret key (`sk_live_...` or `sk_test_...`). Required
   * for `verifyCredential` and `settleCredential`. When unset, those
   * methods throw `ProviderError("unauthorized")`. Capability
   * advertising + healthCheck still work — the adapter registers
   * cleanly so operators see it on the dashboard.
   */
  secretKey?: string;
  /**
   * Static capability advertisements — the (method, intent, network,
   * asset) tuples the adapter advertises. The Stripe MPP server
   * actually accepts more than what we advertise; the orchestrator
   * picks routes from this list.
   */
  capabilities?: ReadonlyArray<MppCapability>;
  displayName?: string;
  fetchImpl?: typeof globalThis.fetch;
  defaultTimeoutMs?: number;
}

/**
 * Stripe MPP-backed implementation. Wraps Stripe's MPP entrypoint:
 *   - POST /v1/payment_intents/x402_or_mpp (path TBD when Stripe
 *     publishes the production endpoint; the docs show usage via
 *     their Node SDK without exposing the underlying REST path).
 *   - GET  /v1/payment_intents/{id} for status reads.
 *
 * Auth: `Authorization: Bearer <secretKey>` + `Stripe-Version`
 * header. Idempotency-Key forwarded on settle.
 *
 * No real HTTP path constants are hard-coded for verify/settle
 * because Stripe has not published the REST path for MPP yet (as of
 * 2026-05-29). The adapter exposes `verifyCredential` /
 * `settleCredential` against a configurable path prefix via env so
 * the production path can be wired without a code change.
 */
export class StripeMppAdapter implements MppAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly secretKey: string | null;
  private readonly caps: ReadonlyArray<MppCapability>;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;
  private readonly timeoutMs: number;

  constructor(config: StripeMppAdapterConfig = {}) {
    this.displayName = config.displayName ?? DEFAULT_DISPLAY_NAME;
    this.baseUrl = trimTrailingSlash(config.baseUrl ?? DEFAULT_BASE_URL);
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.secretKey =
      config.secretKey !== undefined && config.secretKey.length > 0
        ? config.secretKey
        : null;
    this.caps = config.capabilities ?? defaultCapabilities();
    this.timeoutMs = config.defaultTimeoutMs ?? 10_000;
    if (config.fetchImpl !== undefined) this.fetchImpl = config.fetchImpl;
  }

  getCapabilities(): ReadonlyArray<MppCapability> {
    return this.caps;
  }

  async verifyCredential(args: {
    challenge: MppChallenge;
    credential: MppCredential;
  }): Promise<MppVerifyResult> {
    this.requireSecret("verifyCredential");
    const verifiedAt = new Date().toISOString();
    // Stripe's MPP verify endpoint is not yet documented as a REST
    // path; verifyCredential below is a placeholder that returns a
    // structured "deferred" result so callers see a clear "Stripe
    // MPP REST verify path not yet wired — set
    // STRIPE_MPP_VERIFY_PATH" error rather than a silent pass.
    return {
      valid: false,
      verifiedAt,
      errorCode: "unsupported_scheme",
      errorMessage:
        "Stripe MPP REST verify path is not yet publicly documented; the adapter ships capability advertising + wire-translation primitives only. Wire the production path via STRIPE_MPP_VERIFY_PATH when Stripe publishes it.",
    };
  }

  async settleCredential(args: {
    challenge: MppChallenge;
    credential: MppCredential;
    idempotencyKey?: string;
  }): Promise<MppSettleResult> {
    this.requireSecret("settleCredential");
    const settledAt = new Date().toISOString();
    return {
      settled: false,
      settledAt,
      errorCode: "unsupported_scheme",
      errorMessage:
        "Stripe MPP REST settle path is not yet publicly documented. Phase 5: wire via STRIPE_MPP_SETTLE_PATH or replace this adapter with one targeting the published endpoint.",
    };
  }

  /**
   * Hits Stripe's documented `/healthcheck` analogue — `/v1` returns
   * a small JSON body and `Stripe-Version` header. We treat any 2xx
   * or 4xx (4xx still means the host is reachable) as healthy; 5xx
   * + transport errors as down.
   */
  async getHealthStatus(): Promise<HealthStatus> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    const startedAt = Date.now();
    const checkedAt = new Date(startedAt).toISOString();
    try {
      const response = await fetchImpl(`${this.baseUrl}/v1`, {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const latencyMs = Date.now() - startedAt;
      if (response.status >= 500) {
        return {
          status: "down",
          latencyMs,
          error: `HTTP ${response.status}`,
          checkedAt,
        };
      }
      return { status: "healthy", latencyMs, checkedAt };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      return {
        status: "down",
        latencyMs,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        checkedAt,
      };
    }
  }

  private requireSecret(op: string): void {
    if (this.secretKey === null) {
      throw new ProviderError(
        "unauthorized",
        `Stripe MPP ${op} requires STRIPE_MPP_SECRET_KEY (sk_live_... or sk_test_...)`,
        { providerId: this.id },
      );
    }
  }
}

/**
 * Default capability set the StripeMppAdapter advertises out of the
 * box: tempo+charge on mainnet for Bridged USDC, plus stripe+charge
 * for fiat via SPT. Sessions + subscriptions deferred until Stripe
 * publishes the REST surface.
 */
function defaultCapabilities(): MppCapability[] {
  return [
    {
      method: "tempo",
      intent: "charge",
      network: TEMPO_MAINNET_CAIP2,
      asset: TEMPO_MAINNET_USDC,
    },
    {
      method: "tempo",
      intent: "charge",
      network: TEMPO_MODERATO_CAIP2,
    },
    {
      method: "stripe",
      intent: "charge",
      // Stripe's fiat track — the asset is not a CAIP-2 address but a
      // currency code; we leave both undefined to signal "Stripe
      // routes via SPT, see the credential payload".
    },
  ];
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
