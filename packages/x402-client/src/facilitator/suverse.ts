/**
 * Default facilitator URL — the suverse-pay gateway. Override per
 * `new SuverseClient({ defaultFacilitator })` if you point at a
 * different x402 v2 facilitator.
 *
 * The client doesn't talk to the facilitator directly — the seller's
 * 402 response tells the client which facilitator was used. This
 * constant is only here so error messages can name a default when
 * the seller's challenge is malformed.
 */
export const DEFAULT_FACILITATOR_URL = "https://facilitator.suverse.io";
