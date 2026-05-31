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
 * MppFacilitatorAdapter — interface for MPP facilitators, parallel
 * to `ProviderAdapter` for the x402 protocol. Introduced Phase 4
 * Block 2 Sub-task 9; renamed Phase 5 Phase 2 T2 (was `MppAdapter`).
 *
 * MPP and x402 share the "402-then-retry" challenge-response shape
 * but the wire format differs: x402 puts the challenge in the
 * response body + `X-PAYMENT` header; MPP puts it in
 * `WWW-Authenticate: Payment ...` headers. The semantics — verify a
 * credential, then settle on-chain or via a payment processor — map
 * one-to-one.
 */
export interface MppFacilitatorAdapter {
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

/* --- MPP adapter implementation --- */

const ADAPTER_ID = "mpp";
const DEFAULT_DISPLAY_NAME = "Machine Payments Protocol";

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

export interface MppAdapterConfig {
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
 * MPP adapter. One adapter, multiple methods — dispatches by
 * `(method, intent, network)` tuple at verify/settle time:
 *   - tempo + charge + eip155:42431 (Tempo Moderato testnet):
 *     Phase 2 T6 wires direct JSON-RPC settle.
 *   - tempo + charge + eip155:4217 (Tempo mainnet):
 *     stays endpoint-not-wired until Stripe publishes the MPP
 *     REST surface (Stripe-facilitated mainnet path).
 *   - stripe + charge (fiat via SPT): not in v1; returns when
 *     Stripe publishes the REST surface.
 *
 * No HTTP path constants are hard-coded for the Stripe-facilitated
 * track because Stripe has not published REST endpoints for MPP
 * yet (as of 2026-05-29). The adapter exposes `verifyCredential` /
 * `settleCredential` against a configurable path prefix via env so
 * the production path can be wired without a code change.
 */
export class MppAdapter implements MppFacilitatorAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName: string;

  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly secretKey: string | null;
  private readonly caps: ReadonlyArray<MppCapability>;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;
  private readonly timeoutMs: number;

  constructor(config: MppAdapterConfig = {}) {
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
 * Default capability set the MppAdapter advertises out of the box.
 *
 * v1 (Phase 2): tempo+charge on Tempo mainnet (Bridged USDC) and
 * Tempo Moderato testnet. The Moderato entry is the one Phase 2 T6
 * actually wires verify/settle for, via direct JSON-RPC. Mainnet
 * advertises because the wire format is valid and Phase 5 will wire
 * settle through Stripe's REST surface when it's published.
 *
 * NOT in v1:
 *   - `method: "stripe"` (fiat via SPT) — Stripe has not published
 *     the REST surface for MPP yet (as of 2026-05-29). Restore the
 *     entry when Stripe opens the API.
 *   - `intent: "subscription"` / `intent: "session"` — same blocker;
 *     Phase 2 T4 also guards verify/settle against non-charge intents.
 *
 * The `MPP_METHODS` / `MPP_INTENTS` constants in `./types.ts` keep
 * the full spec values for forward-compat parsing of challenges
 * emitted by other facilitators.
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
  ];
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
