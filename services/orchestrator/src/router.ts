import type {
  ProviderHealthSummary,
  RegisteredProvider,
  RoutingContext,
  RoutingDecision,
  ScoredCandidate,
} from "./types.js";

/**
 * Pure routing engine. Implements TASK.md §"Routing logic v0.1" verbatim.
 *
 * - Filters providers that don't support the (network, asset, scheme) tuple.
 * - Filters providers currently marked unhealthy.
 * - Scores remaining candidates by `policy.optimize`.
 * - Respects `policy.providerHint` IF the hint passes both filters.
 *
 * No DB, no Redis, no clocks beyond the `now` parameter. Hand it
 * RegisteredProvider[] + healthSummaries Map and it returns a
 * RoutingDecision.
 */

export const MIN_TRAFFIC_FOR_LIVE_HEALTH_RULE = 10;
export const UNHEALTHY_FAILURE_RATIO = 0.3;
export const QUIET_PERIOD_HEALTH_LOOKBACK_MS = 5 * 60 * 1000;

export interface RouteInput {
  providers: ReadonlyArray<RegisteredProvider>;
  context: RoutingContext;
  healthSummaries: ReadonlyMap<string, ProviderHealthSummary>;
  now: Date;
}

export async function route(input: RouteInput): Promise<RoutingDecision> {
  // Step 1: support filter — call adapter.supports() in parallel.
  const supportChecks = await Promise.all(
    input.providers
      .filter((p) => p.enabled)
      .map(async (p) => ({
        provider: p,
        result: await p.adapter.supports({
          network: input.context.network,
          asset: input.context.asset,
          scheme: input.context.scheme,
        }),
      })),
  );
  const routeSupporters = supportChecks
    .filter((c) => c.result.supported)
    .map((c) => c.provider);

  // Step 2: health filter.
  const healthy = routeSupporters.filter((p) =>
    isHealthy(p.id, input.healthSummaries, input.now),
  );

  // Step 3: score.
  const baseScored = healthy.map((p) =>
    scoreProvider(p, input.context, input.healthSummaries.get(p.id)),
  );

  // Sort ascending by score (lower wins).
  baseScored.sort((a, b) => a.score - b.score);

  // Step 4: provider hint promotion. The hint moves to the front IFF
  // it passed both filters (i.e. is already in baseScored). A hint
  // pointing at an unhealthy or unsupported provider is silently
  // ignored — falling back to the natural score order.
  let ordered = baseScored;
  const hint = input.context.policy.providerHint;
  if (hint !== undefined) {
    const hintIdx = ordered.findIndex((s) => s.providerId === hint);
    if (hintIdx > 0) {
      const [hinted] = ordered.splice(hintIdx, 1);
      ordered = [hinted!, ...ordered];
    }
  }

  // Re-rank from 0.
  const candidates: ScoredCandidate[] = ordered.map((s, i) => ({
    providerId: s.providerId,
    rank: i,
    score: s.score,
    reason:
      i === 0 && hint === ordered[0]?.providerId
        ? `${s.reason} (provider_hint)`
        : s.reason,
  }));

  return {
    candidates,
    selected: candidates[0]?.providerId ?? null,
    policyUsed: input.context.policy,
    optimize: input.context.policy.optimize,
    decidedAt: input.now,
  };
}

function isHealthy(
  providerId: string,
  summaries: ReadonlyMap<string, ProviderHealthSummary>,
  now: Date,
): boolean {
  const s = summaries.get(providerId);
  if (s === undefined) {
    return true; // No data → assume healthy.
  }
  // Live-traffic rule: enough attempts to be statistically meaningful.
  if (s.recentAttempts >= MIN_TRAFFIC_FOR_LIVE_HEALTH_RULE) {
    const ratio = s.recentFailures / s.recentAttempts;
    return ratio < UNHEALTHY_FAILURE_RATIO;
  }
  // Quiet period: fall back to provider_health_checks only if recent.
  if (s.lastCheck !== null) {
    const ageMs = now.getTime() - s.lastCheck.checkedAt.getTime();
    if (ageMs <= QUIET_PERIOD_HEALTH_LOOKBACK_MS) {
      return s.lastCheck.status === "healthy";
    }
  }
  // Live attempts < threshold AND no recent active check → assume healthy.
  return true;
}

interface BaseScore {
  providerId: string;
  score: number;
  reason: string;
}

function scoreProvider(
  provider: RegisteredProvider,
  context: RoutingContext,
  summary: ProviderHealthSummary | undefined,
): BaseScore {
  switch (context.policy.optimize) {
    case "cost": {
      const fee =
        summary?.estimatedFeeUsd !== undefined
          ? Number.parseFloat(summary.estimatedFeeUsd)
          : Number.POSITIVE_INFINITY;
      return {
        providerId: provider.id,
        score: Number.isFinite(fee) ? fee : Number.POSITIVE_INFINITY,
        reason: "lowest_cost",
      };
    }
    case "latency": {
      const latency =
        summary?.avgLatencyMs7d ??
        summary?.estimatedLatencyMs ??
        Number.POSITIVE_INFINITY;
      return {
        providerId: provider.id,
        score: latency,
        reason: "lowest_latency",
      };
    }
    case "success_rate": {
      const rate = summary?.successRate7d ?? 0;
      return {
        providerId: provider.id,
        // Lower score wins; invert so highest rate sorts first.
        score: -rate,
        reason: "highest_success_rate",
      };
    }
  }
}
