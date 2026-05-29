import type { WebhookEventType } from "./endpoints-store.js";

/**
 * Wire envelope for a webhook event. Receivers parse this from the
 * raw request body and route on `type`.
 *
 * Shape mirrors Stripe's `Event` object — the convention is
 * widespread enough that integrators reach for `stripe.webhooks.*`
 * patterns even when the source is not Stripe.
 */
export interface WebhookEventEnvelope<T = Record<string, unknown>> {
  /** Globally unique event id. Receivers MUST dedupe on this. */
  id: string;
  /** Event type, dotted convention: `<resource>.<verb>`. */
  type: WebhookEventType;
  /** Unix seconds when the event was emitted. */
  created: number;
  /** Source object — for v1 events, the facilitator_payment row. */
  data: { object: T };
  /**
   * Source advertised in case we ever publish from multiple
   * endpoints (e.g. a billing sub-domain). Lets receivers
   * `if (event.source !== 'suverse-pay') reject` defensively.
   */
  source: "suverse-pay";
}

export interface SettlePayloadObject {
  /** facilitator_payments.id — `fpay_<ulid>`. */
  id: string;
  /** Resource API key id (so customer can scope per-key on receive). */
  resource_key_id: string;
  /** CAIP-2 chain identifier. */
  network: string;
  /** Asset symbol (USDC, USDT, …). */
  asset: string;
  /** x402 scheme used (exact, exact_permit, …). */
  scheme: string;
  /** Atomic units of the gross transfer (= what hit the chain). */
  gross_amount: string;
  /** Atomic units withheld as suverse-pay platform fee (accounting). */
  fee_amount: string;
  /** Atomic units the merchant nets after fee. */
  net_amount: string;
  /** Payer address when known. */
  payer: string | null;
  /** Merchant receiving address (= paymentRequirements.payTo). */
  recipient: string;
  /** Which downstream adapter routed this (coinbase-cdp, payai, …). */
  adapter_used: string | null;
  /** On-chain transaction hash when known. */
  tx_hash: string | null;
  /** "settled" | "failed". */
  status: string;
  /** Error code if status='failed'. */
  error_code: string | null;
  /** Error message if status='failed'. */
  error_message: string | null;
  /** ISO timestamp of facilitator_payments.created_at. */
  created_at: string;
  /** ISO timestamp of facilitator_payments.settled_at (null if failed). */
  settled_at: string | null;
}

export function buildSettleEnvelope(args: {
  eventId: string;
  eventType: WebhookEventType;
  now: Date;
  object: SettlePayloadObject;
}): WebhookEventEnvelope<SettlePayloadObject> {
  return {
    id: args.eventId,
    type: args.eventType,
    created: Math.floor(args.now.getTime() / 1000),
    data: { object: args.object },
    source: "suverse-pay",
  };
}
