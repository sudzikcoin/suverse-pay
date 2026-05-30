/**
 * Cosmos signer stub — Phase 4 deliverable.
 *
 * Will use `@cosmjs/proto-signing` + `@cosmjs/crypto` directly,
 * mirroring the working pattern in `packages/signers/cosmos/src/sign.ts`
 * but without the NETWORK_PREFIX whitelist guard the internal
 * signer adds (the buyer-side SDK accepts whatever the seller's
 * challenge advertises).
 */
import { X402ClientError } from "../types.js";
import type {
  AcceptedRequirement,
  CosmosWallet,
  PaymentEnvelope,
} from "../types.js";

export interface CosmosSignParams {
  readonly wallet: CosmosWallet;
  readonly requirement: AcceptedRequirement;
  /** Resource URL — required by `exact_cosmos_authz` signed bytes. */
  readonly resource: string;
}

export async function signCosmosPayment(
  _params: CosmosSignParams,
): Promise<PaymentEnvelope> {
  throw new X402ClientError(
    "not_implemented",
    "Cosmos signer is Phase 4 — not in v0.1.0. Use the EVM signer or pin to a release that includes Cosmos.",
  );
}
