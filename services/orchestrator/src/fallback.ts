import {
  ProviderError,
  isRetryableErrorCode,
  type MerchantPolicy,
  type SettleOptions,
  type SettleRequest,
  type SettleResponse,
} from "@suverse-pay/core-types";
import type {
  AttemptOutcome,
  FallbackLedgerHooks,
  RegisteredProvider,
} from "./types.js";

/**
 * Orchestrates settle attempts across an ordered candidate list.
 *
 * Per CLAUDE.md §"Critical invariants — Observability before
 * optimization", we write a payment_attempts row BEFORE every
 * network call via `ledger.startAttempt()`, and update it with the
 * final outcome after via `ledger.finishAttempt()`. If the process
 * crashes between the two, the row remains as outcome='pending' and
 * a future cleanup cron (out of scope for Phase 1) can resolve it.
 *
 * Pure orchestration — no DB / Redis. The ledger interface is
 * injected so tests can supply an in-memory recorder.
 *
 * Retry policy across providers follows TASK.md §"Fallback in /settle":
 * we move to the next candidate only when the previous attempt
 * surfaced a retryable error code. Non-retryable codes (user-side
 * problems like invalid_signature, insufficient_funds, etc.) are
 * returned to the caller immediately.
 */
export interface FallbackInput {
  paymentId: string;
  request: SettleRequest;
  options: SettleOptions;
  policy: MerchantPolicy;
  /**
   * Candidates in score order — typically the `selected`+rest from
   * the router. The caller has already verified each candidate
   * supports the route, but we re-check on every attempt because
   * capability state can drift mid-flight (e.g. an adapter's quota
   * flips between attempts).
   */
  candidates: ReadonlyArray<RegisteredProvider>;
  ledger: FallbackLedgerHooks;
  /** Override for tests; defaults to () => new Date(). */
  now?: () => Date;
}

export interface FallbackResult {
  finalResponse: SettleResponse | null;
  attempts: AttemptOutcome[];
}

export async function runFallback(input: FallbackInput): Promise<FallbackResult> {
  const now = input.now ?? (() => new Date());
  const attempts: AttemptOutcome[] = [];
  const maxAttempts = Math.min(
    input.policy.maxAttempts,
    input.candidates.length,
  );

  for (let i = 0; i < maxAttempts; i++) {
    const provider = input.candidates[i]!;

    // Re-check route support — quota / cap state may have changed.
    const support = await provider.adapter.supports({
      network: input.request.paymentRequirements.network,
      asset: input.request.paymentRequirements.asset,
      scheme: input.request.paymentRequirements.scheme,
    });
    if (!support.supported) {
      continue; // Skip; don't write an attempt row.
    }

    const attemptNumber = attempts.length + 1;
    const startedAt = now();
    await input.ledger.startAttempt(input.paymentId, provider.id, attemptNumber);

    let response: SettleResponse | null = null;
    let thrown: unknown = null;
    try {
      response = await provider.adapter.settle(input.request, input.options);
    } catch (err) {
      thrown = err;
    }
    const completedAt = now();
    const latencyMs = completedAt.getTime() - startedAt.getTime();

    if (thrown !== null) {
      const providerErr =
        thrown instanceof ProviderError ? thrown : null;
      const outcome: AttemptOutcome = {
        attemptNumber,
        providerId: provider.id,
        startedAt,
        completedAt,
        outcome: "failed",
        latencyMs,
        errorCode: providerErr?.code ?? "unexpected_settle_error",
        errorMessage:
          thrown instanceof Error ? thrown.message : String(thrown),
      };
      attempts.push(outcome);
      await input.ledger.finishAttempt(input.paymentId, attemptNumber, outcome);

      if (providerErr !== null && providerErr.isRetryable()) {
        continue;
      }
      // Non-retryable thrown error — return synthetic failure so caller
      // can persist + respond. Don't bubble — we have richer context.
      return {
        finalResponse: {
          settled: false,
          providerId: provider.id,
          network: input.request.paymentRequirements.network,
          asset: input.request.paymentRequirements.asset,
          amount: input.request.paymentRequirements.maxAmountRequired,
          errorCode: outcome.errorCode!,
          ...(outcome.errorMessage !== undefined
            ? { errorMessage: outcome.errorMessage }
            : {}),
        },
        attempts,
      };
    }

    // response != null
    const r = response!;
    if (r.settled) {
      const outcome: AttemptOutcome = {
        attemptNumber,
        providerId: provider.id,
        startedAt,
        completedAt,
        outcome: "success",
        latencyMs,
        ...(r.txHash !== undefined ? { txHash: r.txHash } : {}),
      };
      attempts.push(outcome);
      await input.ledger.finishAttempt(input.paymentId, attemptNumber, outcome);
      return { finalResponse: r, attempts };
    }

    // Settle returned settled=false — business-level failure with an
    // explicit errorCode. Move on iff the code is retryable.
    const outcome: AttemptOutcome = {
      attemptNumber,
      providerId: provider.id,
      startedAt,
      completedAt,
      outcome: "failed",
      latencyMs,
      ...(r.errorCode !== undefined ? { errorCode: r.errorCode } : {}),
      ...(r.errorMessage !== undefined ? { errorMessage: r.errorMessage } : {}),
    };
    attempts.push(outcome);
    await input.ledger.finishAttempt(input.paymentId, attemptNumber, outcome);

    const retryable =
      r.errorCode !== undefined && isRetryableErrorCode(r.errorCode);
    if (!retryable) {
      return { finalResponse: r, attempts };
    }
    // Loop continues to next candidate.
  }

  // Exhausted maxAttempts or candidate list with all retryable
  // failures. The last attempt (if any) carries the most recent
  // failure detail; build a synthetic response from it.
  const last = attempts[attempts.length - 1];
  if (last === undefined) {
    return { finalResponse: null, attempts };
  }
  return {
    finalResponse: {
      settled: false,
      providerId: last.providerId,
      network: input.request.paymentRequirements.network,
      asset: input.request.paymentRequirements.asset,
      amount: input.request.paymentRequirements.maxAmountRequired,
      errorCode: last.errorCode ?? "unexpected_settle_error",
      ...(last.errorMessage !== undefined
        ? { errorMessage: last.errorMessage }
        : {}),
    },
    attempts,
  };
}
