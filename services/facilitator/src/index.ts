export {
  ROUTING_CONFIG,
  getRoutingPriority,
  routingKey,
  type RoutingPriority,
} from "./routing-config.js";

export {
  deriveFacilitatorIdempotencyKey,
  extractPayloadNonce,
  extractPayerAddress,
} from "./idempotency-key.js";

export {
  FacilitatorRateLimiter,
  type RateLimitDecision,
  type RateLimitDeps,
} from "./rate-limit.js";

export {
  createOrFetchFacilitatorPayment,
  finalizeFacilitatorPayment,
  recordFailoverEvent,
  type CreateFacilitatorPaymentOptions,
  type CreateResult,
  type FacilitatorPaymentRow,
  type FacilitatorPaymentStatus,
  type FinalizeFacilitatorPaymentOptions,
  type RecordFailoverOptions,
} from "./payments-log.js";

export {
  pickAdaptersForRoute,
  routeVerify,
  routeSettleWithFailover,
  type FailoverAttempt,
  type PickAdaptersResult,
  type RouteSettleDeps,
  type RouteSettleResult,
  type RouteVerifyResult,
} from "./router.js";

export {
  buildSupportedResponse,
  isRouteSupported,
  type FacilitatorSupportedKind,
  type FacilitatorSupportedResponse,
} from "./supported.js";
