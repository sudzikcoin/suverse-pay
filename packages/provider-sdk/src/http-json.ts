import { ProviderError, type ErrorCode } from "@suverse-pay/core-types";
import { withRetry, type RetryOptions } from "./retry.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface HttpJsonOptions {
  method?: HttpMethod;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retry?: Omit<RetryOptions, "providerId">;
  /**
   * When set, sent as `Idempotency-Key` on every attempt (including
   * retries). REQUIRED on any non-idempotent call (e.g. /settle) that
   * enables `retry`; without it, a retry on a 5xx response can
   * double-trigger the downstream operation.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  providerId?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export interface HttpJsonResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function httpJson<T = unknown>(
  url: string,
  opts: HttpJsonOptions = {},
): Promise<HttpJsonResponse<T>> {
  if (opts.retry !== undefined) {
    return withRetry(() => httpJsonOnce<T>(url, opts), {
      ...opts.retry,
      ...(opts.providerId !== undefined ? { providerId: opts.providerId } : {}),
    });
  }
  return httpJsonOnce<T>(url, opts);
}

async function httpJsonOnce<T>(
  url: string,
  opts: HttpJsonOptions,
): Promise<HttpJsonResponse<T>> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(opts.headers ?? {}),
  };
  const hasBody = opts.body !== undefined;
  if (hasBody && headers["Content-Type"] === undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (opts.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = opts.idempotencyKey;
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal,
    });
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw new ProviderError(
        "timeout",
        `${method} ${url} timed out after ${timeoutMs}ms`,
        providerErrorOpts(opts.providerId, err),
      );
    }
    if (opts.signal?.aborted) {
      // Caller cancelled — not retryable, surface as a network_error so
      // the orchestrator sees it but the underlying AbortError isn't
      // swallowed.
      throw new ProviderError(
        "network_error",
        `${method} ${url} aborted by caller`,
        providerErrorOpts(opts.providerId, err),
      );
    }
    throw new ProviderError(
      "network_error",
      `${method} ${url} failed: ${describeError(err)}`,
      providerErrorOpts(opts.providerId, err),
    );
  }

  if (response.status >= 200 && response.status < 300) {
    let data: T;
    try {
      data = (await response.json()) as T;
    } catch (err) {
      throw new ProviderError(
        "provider_internal_error",
        `${method} ${url} returned non-JSON body on HTTP ${response.status}`,
        providerErrorOpts(opts.providerId, err),
      );
    }
    return { data, status: response.status, headers: response.headers };
  }

  const errorCode = httpStatusToErrorCode(response.status);
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    // ignore body read failures — we already have status
  }
  throw new ProviderError(
    errorCode,
    `${method} ${url} -> HTTP ${response.status}${bodyText ? `: ${truncate(bodyText, 200)}` : ""}`,
    providerErrorOpts(opts.providerId),
  );
}

export function httpStatusToErrorCode(status: number): ErrorCode {
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if (status === 503) return "temporary_unavailable";
  if (status >= 500) return "provider_internal_error";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  return "invalid_request";
}

function providerErrorOpts(
  providerId: string | undefined,
  cause?: unknown,
): { providerId?: string; cause?: unknown } {
  const out: { providerId?: string; cause?: unknown } = {};
  if (providerId !== undefined) out.providerId = providerId;
  if (cause !== undefined) out.cause = cause;
  return out;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
