/**
 * TRON signer stub — Phase 5 deliverable.
 *
 * Will support three schemes:
 *   - `exact` — direct TRC-20 USDT transferWithAuthorization
 *     (if contract supports it).
 *   - `exact_permit` — EIP-2612-style permit.
 *   - `exact_gasfree` — sponsored relay via gasfree.io.
 *
 * gasfree.io has a documented minimum (~$1 USDT). The signer will
 * throw `InsufficientAmountError` when the requirement's amount is
 * below $1.50 USDT to avoid a guaranteed-fail relay.
 */
import { X402ClientError } from "../types.js";
import type {
  AcceptedRequirement,
  PaymentEnvelope,
  TronWallet,
} from "../types.js";

export interface TronSignParams {
  readonly wallet: TronWallet;
  readonly requirement: AcceptedRequirement;
}

export async function signTronPayment(
  _params: TronSignParams,
): Promise<PaymentEnvelope> {
  throw new X402ClientError(
    "not_implemented",
    "TRON signer is Phase 5 — not in v0.1.0. Use the EVM signer or pin to a release that includes TRON.",
  );
}
