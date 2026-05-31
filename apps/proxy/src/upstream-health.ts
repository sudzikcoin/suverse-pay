/**
 * Pre-charge upstream health probe.
 *
 * Before we hand back a 402 challenge to a buyer, we make sure the
 * upstream the buyer is about to pay for is actually answering. A
 * dead upstream returning 503 is preferable to a 402 that pulls
 * funds for a broken endpoint.
 *
 * Strategy:
 *  1. HEAD with a shared abort budget (`timeoutMs`, default 3000ms).
 *  2. If HEAD comes back 405/501 (some APIs — AWS API Gateway is the
 *     usual culprit — refuse HEAD), retry once with GET against the
 *     same budget.
 *  3. Classify:
 *       - 1xx/2xx/3xx/4xx → ok: server is alive. A 401/403/404 just
 *         means the probe path needs auth or the resource is gated;
 *         the buyer's paid call will carry the seller's encrypted
 *         headers and a different shape, so the probe verdict is
 *         "server is up", not "endpoint is open".
 *       - 5xx → not ok. Server up but broken.
 *       - AbortError → not ok, timeout.
 *       - Any other thrown error (DNS, ECONNREFUSED, TLS …) →
 *         not ok, network_error.
 *
 * The probe is best-effort: any unexpected exception (e.g. an
 * invalid URL stored in the config table) is folded into a
 * `network_error` result rather than propagated, so a single bad
 * row can't crash the proxy hot path.
 */

export type HealthCheckReason = "timeout" | "network_error" | "upstream_5xx";

export interface HealthCheckResult {
  readonly ok: boolean;
  readonly reason?: HealthCheckReason;
  /** HTTP status from the probe, if we got one. */
  readonly status?: number;
  /** Wall-clock duration of the probe. */
  readonly latencyMs: number;
  /** Which method finally resolved the verdict. */
  readonly method?: "HEAD" | "GET";
}

export interface CheckUpstreamHealthArgs {
  readonly url: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: Pick<Console, "info" | "warn" | "error">;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/** Statuses that mean "this upstream doesn't speak HEAD — try GET". */
const HEAD_REFUSED_STATUSES = new Set([405, 501]);

export async function checkUpstreamHealth(
  args: CheckUpstreamHealthArgs,
): Promise<HealthCheckResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    let method: "HEAD" | "GET" = "HEAD";
    try {
      response = await fetchImpl(args.url, {
        method: "HEAD",
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      return classifyError(err, start, method);
    }

    if (HEAD_REFUSED_STATUSES.has(response.status)) {
      // Drain the HEAD body (HEAD is normally empty, but Node's fetch
      // still keeps the connection open until the body is consumed).
      await drainBody(response);
      method = "GET";
      try {
        response = await fetchImpl(args.url, {
          method: "GET",
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (err) {
        return classifyError(err, start, method);
      }
    }

    // We don't care about the body — only the status line. Cancel
    // so the underlying socket can be released.
    await drainBody(response);

    const latencyMs = Date.now() - start;
    if (response.status >= 500 && response.status <= 599) {
      args.logger?.warn?.(
        `proxy: upstream health 5xx url=${args.url} status=${response.status}`,
      );
      return {
        ok: false,
        reason: "upstream_5xx",
        status: response.status,
        latencyMs,
        method,
      };
    }
    return { ok: true, status: response.status, latencyMs, method };
  } finally {
    clearTimeout(timer);
  }
}

function classifyError(
  err: unknown,
  start: number,
  method: "HEAD" | "GET",
): HealthCheckResult {
  const latencyMs = Date.now() - start;
  const isAbort =
    err instanceof Error &&
    (err.name === "AbortError" ||
      // Node's fetch wraps the abort in a TypeError("fetch failed")
      // with a `.cause` whose `.name` is "AbortError".
      (typeof (err as { cause?: unknown }).cause === "object" &&
        (err as { cause?: { name?: string } }).cause?.name === "AbortError"));
  if (isAbort) {
    return { ok: false, reason: "timeout", latencyMs, method };
  }
  return { ok: false, reason: "network_error", latencyMs, method };
}

async function drainBody(response: Response): Promise<void> {
  // `response.body` is a ReadableStream we don't need. Cancel it so
  // the keep-alive socket is returned to the pool quickly.
  try {
    await response.body?.cancel();
  } catch {
    /* ignore — we're discarding bytes either way */
  }
}
