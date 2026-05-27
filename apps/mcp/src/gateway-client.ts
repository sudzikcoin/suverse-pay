// Thin HTTP wrapper around the suverse-pay REST API. The MCP server
// authenticates to the gateway using the admin API key (server-only
// secret — never given to MCP clients/agents). The agent's session
// secret is unrelated and stays in-memory on the MCP server.

const DEFAULT_TIMEOUT_MS = 10_000;
const SETTLE_TIMEOUT_MS = 30_000;

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code: string | null,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface QuoteRequestBody {
  asset: string;
  amount: string;
  preferredNetworks: string[];
  scheme: string;
  policy?: { optimize?: "cost" | "latency" | "success_rate" };
}

export interface SettleRequestBody {
  paymentPayload: unknown;
  paymentRequirements: unknown;
  policy?: Record<string, unknown>;
}

export interface VerifyRequestBody {
  paymentPayload: unknown;
  paymentRequirements: unknown;
  providerHint?: string;
}

export interface GatewayClientConfig {
  baseUrl: string;
  adminKey: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Default timeout for /providers, /quote, /verify, /payments. */
  timeoutMs?: number;
  /** Longer timeout for /settle, which broadcasts on-chain. */
  settleTimeoutMs?: number;
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly adminKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly settleTimeoutMs: number;

  constructor(config: GatewayClientConfig) {
    // Strip trailing slash so callers can pass either form.
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.adminKey = config.adminKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.settleTimeoutMs = config.settleTimeoutMs ?? SETTLE_TIMEOUT_MS;
  }

  async getProviders(): Promise<unknown> {
    return this.request("GET", "/providers", undefined, undefined, this.timeoutMs);
  }

  async getQuote(body: QuoteRequestBody): Promise<unknown> {
    return this.request("POST", "/quote", body, undefined, this.timeoutMs);
  }

  async verify(body: VerifyRequestBody): Promise<unknown> {
    return this.request("POST", "/verify", body, undefined, this.timeoutMs);
  }

  async settle(body: SettleRequestBody, idempotencyKey: string): Promise<unknown> {
    return this.request(
      "POST",
      "/settle",
      body,
      { "Idempotency-Key": idempotencyKey },
      this.settleTimeoutMs,
    );
  }

  async getPayment(id: string): Promise<unknown> {
    const encoded = encodeURIComponent(id);
    return this.request("GET", `/payments/${encoded}`, undefined, undefined, this.timeoutMs);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.adminKey}`,
      ...extraHeaders,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const resp = await this.fetchImpl(url, init);
      let parsed: unknown = null;
      const text = await resp.text();
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!resp.ok) {
        const code = extractErrorCode(parsed);
        throw new GatewayError(
          `gateway ${method} ${path} returned HTTP ${resp.status}`,
          resp.status,
          code,
          parsed,
        );
      }
      return parsed;
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new GatewayError(
          `gateway ${method} ${path} timed out after ${timeoutMs}ms`,
          null,
          "gateway_timeout",
          null,
        );
      }
      throw new GatewayError(
        `gateway ${method} ${path} network error: ${
          err instanceof Error ? err.message : String(err)
        }`,
        null,
        "gateway_unreachable",
        null,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractErrorCode(parsed: unknown): string | null {
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.code === "string") return obj.code;
    if (obj.error && typeof obj.error === "object") {
      const code = (obj.error as Record<string, unknown>).code;
      if (typeof code === "string") return code;
    }
  }
  return null;
}
