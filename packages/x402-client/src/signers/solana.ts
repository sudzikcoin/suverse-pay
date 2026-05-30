/**
 * Solana signer stub — Phase 3 deliverable.
 *
 * The shape is intentionally minimal: the SuverseClient feature-checks
 * by attempting `signFor` and catches `NotImplementedError` to fall
 * back to other configured wallets. When Phase 3 lands this file
 * gains the real ed25519 + SPL transferChecked signing path.
 */
import { X402ClientError } from "../types.js";
import type {
  AcceptedRequirement,
  PaymentEnvelope,
  SolanaWallet,
} from "../types.js";

export interface SolanaSignParams {
  readonly wallet: SolanaWallet;
  readonly requirement: AcceptedRequirement;
}

export async function signSolanaPayment(
  _params: SolanaSignParams,
): Promise<PaymentEnvelope> {
  throw new X402ClientError(
    "not_implemented",
    "Solana signer is Phase 3 — not in v0.1.0. Use the EVM signer or pin to a release that includes Solana.",
  );
}
