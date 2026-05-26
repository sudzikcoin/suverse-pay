import { ProviderError } from "@suverse-pay/core-types";

export interface TimeoutOptions {
  providerId?: string;
  message?: string;
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  opts: TimeoutOptions = {},
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new ProviderError(
          "timeout",
          opts.message ?? `Operation timed out after ${timeoutMs}ms`,
          opts.providerId !== undefined ? { providerId: opts.providerId } : {},
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
