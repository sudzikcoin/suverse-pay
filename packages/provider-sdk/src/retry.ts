import { ProviderError } from "@suverse-pay/core-types";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  providerId?: string;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function computeBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean,
  random: () => number = Math.random,
): number {
  const expo = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  if (!jitter) return expo;
  return Math.floor(expo * (0.5 + random() * 0.5));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  if (opts.maxAttempts < 1) {
    throw new Error(`withRetry: maxAttempts must be >= 1, got ${opts.maxAttempts}`);
  }
  const baseDelayMs = opts.baseDelayMs ?? 100;
  const maxDelayMs = opts.maxDelayMs ?? 2_000;
  const jitter = opts.jitter ?? true;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof ProviderError && err.isRetryable();
      if (!retryable || attempt === opts.maxAttempts) {
        throw err;
      }
      const delay = computeBackoff(attempt, baseDelayMs, maxDelayMs, jitter);
      await sleep(delay);
    }
  }
  throw lastError;
}
