/**
 * Public surface of @suverselabs/x402-server. Framework-specific
 * adapters live behind subpath exports (`./express`, `./fastify`)
 * so importing the root entry doesn't load Express or Fastify
 * unless the seller actually uses one.
 */

export {
  buildChallenge,
  decodePaymentHeader,
  matchRequirement,
  runProtocol,
  validateOptions,
} from "./core.js";
export type {
  ChallengeBody,
  DecodedPaymentHeader,
  ProtocolResult,
} from "./core.js";
export type {
  AcceptedPayment,
  MiddlewareOptions,
  PaymentReceipt,
} from "./types.js";
export { X402Error } from "./types.js";

// v0.3.0: facilitator-extras auto-discovery. Most users don't need
// these directly — `buildChallenge` consumes them transparently —
// but they're exported for explicit boot-warming, debugging, and
// tests.
export {
  getFacilitatorExtras,
  getAllFacilitatorExtras,
  warmFacilitatorCache,
} from "./discover.js";
export type { FacilitatorExtrasOptions } from "./discover.js";
