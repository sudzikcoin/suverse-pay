/**
 * x402-liveness-check — $0.25 probe-level health verdict for any x402
 * resource URL. We hit the target WITHOUT paying it (no payment
 * headers, no settle) and classify its x402 surface:
 *
 *   ALIVE    — HTTP 402 with a well-formed challenge (x402Version,
 *              non-empty accepts, each accept has scheme+network+payTo
 *              and a positive amount/maxAmountRequired).
 *   DEGRADED — reachable but not a clean x402 surface: non-402 status
 *              (may be free / POST-only / wrong path), a 3xx redirect
 *              (never followed — SSRF policy), malformed 402 body or
 *              invalid accepts, or latency > 5000 ms.
 *   DEAD     — network/DNS/TLS error, timeout, or HTTP 5xx.
 *
 * Every reachable-or-not outcome is a legitimate paid 200 answer — the
 * verdict IS the product. What is NOT chargeable is a request we could
 * never probe: garbage/missing resource_url or an SSRF-blocked target
 * is rejected in the preflight (422, buyer not charged).
 *
 * SSRF guard (mandatory): loopback, RFC1918, link-local (incl. the
 * 169.254.169.254 metadata IP), CGNAT, unspecified, IPv6 unique-local,
 * any localhost name, credentials-in-URL and non-http(s) schemes are
 * all blocked — both as literal IPs and via DNS resolution of the
 * hostname (all addresses). A DNS lookup FAILURE is not a block: an
 * unresolvable host is exactly the "DEAD: dns_error" verdict the buyer
 * is paying for, so the probe proceeds and reports it.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerPreflight,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";
import { isPlaceholderValue, type InternalHandlerInputSchema } from "./discovery.js";

const PROBE_METHODS = ["GET", "POST", "HEAD"] as const;
type ProbeMethod = (typeof PROBE_METHODS)[number];

/** Total probe budget (connect + headers + body). */
const TOTAL_TIMEOUT_MS = 8_000;
/** Reachable but slower than this → DEGRADED even with a valid 402. */
const SLOW_LATENCY_MS = 5_000;
/** raw.challenge_body cap. */
const RAW_BODY_CAP = 4_096;
const PROBE_UA = "SuVerse-LivenessCheck/1.0 (+https://proxy.suverse.io)";

// ─────────────────────────────────────────────────────────────────────
// Input parsing (shared by validator / preflight / handler)
// ─────────────────────────────────────────────────────────────────────

export type LivenessParse =
  | { kind: "discovery" }
  | { kind: "invalid_json" }
  | { kind: "malformed" }
  | { kind: "invalid_url"; value: string }
  | { kind: "invalid_method"; value: string }
  | { kind: "invalid_request_body" }
  | {
      kind: "ok";
      resourceUrl: string;
      method: ProbeMethod;
      requestBody: Record<string, unknown> | null;
    };

export function parseLivenessBody(body: Buffer | null): LivenessParse {
  if (!body || body.length === 0 || body.toString("utf8").trim() === "") {
    return { kind: "discovery" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { kind: "invalid_json" };
  }
  if (parsed === null) return { kind: "discovery" };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed" };
  }
  const obj = parsed as Record<string, unknown>;
  const raw = obj["resource_url"] ?? obj["url"];
  // Missing / non-string / placeholder → discovery: the schema-blind
  // probe gets the 402 challenge with input_schema, never a 422.
  if (typeof raw !== "string" || isPlaceholderValue(raw)) {
    return { kind: "discovery" };
  }
  const value = raw.trim();
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { kind: "invalid_url", value };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { kind: "invalid_url", value };
  }
  let method: ProbeMethod = "GET";
  const rawMethod = obj["method"];
  if (rawMethod !== undefined && rawMethod !== null && rawMethod !== "") {
    const m = String(rawMethod).toUpperCase();
    if (!PROBE_METHODS.includes(m as ProbeMethod)) {
      return { kind: "invalid_method", value: String(rawMethod) };
    }
    method = m as ProbeMethod;
  }
  let requestBody: Record<string, unknown> | null = null;
  const rb = obj["request_body"];
  if (rb !== undefined && rb !== null) {
    if (typeof rb !== "object" || Array.isArray(rb)) {
      return { kind: "invalid_request_body" };
    }
    requestBody = rb as Record<string, unknown>;
  }
  return { kind: "ok", resourceUrl: value, method, requestBody };
}

export const x402LivenessCheckInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: ["resource_url"],
    properties: {
      resource_url: {
        type: "string",
        description:
          "Full http(s) URL of the x402 resource to probe (we request it unpaid and grade its 402 challenge).",
        pattern: "^https?://",
      },
      method: {
        type: "string",
        description: "HTTP method for the probe: GET | POST | HEAD. Default GET.",
        pattern: "^(GET|POST|HEAD)$",
      },
      request_body: {
        type: "object",
        description:
          "Optional JSON object sent as the probe body when method is POST (many x402 endpoints only answer 402 on POST).",
      },
    },
  },
  example: {
    resource_url: "https://proxy.suverse.io/v1/data/crypto-market-pulse",
    method: "POST",
  },
};

// ─────────────────────────────────────────────────────────────────────
// SSRF guard
// ─────────────────────────────────────────────────────────────────────

export type SsrfLookupFn = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export type SsrfGuard = (
  url: string,
) => Promise<{ allowed: boolean; reason?: string }>;

function parseIPv4(s: string): number[] | null {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return parts.every((p) => p <= 255) ? parts : null;
}

function blockedV4Reason(parts: number[]): string | null {
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 127) return "loopback_127/8";
  if (a === 10) return "private_10/8";
  if (a === 172 && b >= 16 && b <= 31) return "private_172.16/12";
  if (a === 192 && b === 168) return "private_192.168/16";
  if (a === 169 && b === 254) return "link_local_169.254/16_metadata_range";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat_100.64/10";
  if (a === 0) return "unspecified_0/8";
  if (a >= 224) return "multicast_or_reserved_224/3";
  return null;
}

/**
 * Expand an IPv6 literal into its 8 16-bit groups, handling `::`
 * compression and a trailing dotted-quad (`::ffff:127.0.0.1`).
 * Returns null when the literal doesn't parse — callers treat that as
 * BLOCKED (fail closed: the host claimed to be an IP literal).
 */
function expandV6(addrRaw: string): number[] | null {
  const addr = addrRaw.toLowerCase();
  let head = addr;
  let v4: number[] | null = null;
  if (addr.includes(".")) {
    const i = addr.lastIndexOf(":");
    if (i === -1) return null;
    v4 = parseIPv4(addr.slice(i + 1));
    if (!v4) return null;
    head = addr.slice(0, i);
  }
  const groupsNeeded = v4 ? 6 : 8;
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  let groups: number[];
  if (halves.length === 2) {
    const left = toGroups(halves[0] ?? "");
    const right = toGroups(halves[1] ?? "");
    if (left === null || right === null) return null;
    const fill = groupsNeeded - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array<number>(fill).fill(0), ...right];
  } else {
    const g = toGroups(head);
    if (g === null || g.length !== groupsNeeded) return null;
    groups = g;
  }
  if (v4) {
    const [o0 = 0, o1 = 0, o2 = 0, o3 = 0] = v4;
    groups.push((o0 << 8) | o1, (o2 << 8) | o3);
  }
  return groups.length === 8 ? groups : null;
}

function blockedV6Reason(addr: string): string | null {
  const g = expandV6(addr);
  // Contains ":" so it claimed to be IPv6; unparseable → fail closed.
  if (g === null) return "unparseable_ipv6_literal";
  const first = g[0] ?? 0;
  if (g.every((x) => x === 0)) return "unspecified_v6";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback_v6";
  // v4-mapped ::ffff:0:0/96 (any spelling: dotted OR hex groups) and
  // the deprecated v4-compatible ::/96 — grade the embedded v4.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const g6 = g[6] ?? 0;
    const g7 = g[7] ?? 0;
    const v4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
    const r = blockedV4Reason(v4);
    return r ? `v4_mapped_${r}` : null;
  }
  // NAT64 64:ff9b::/96 — the embedded v4 is the real target.
  if (first === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const g6 = g[6] ?? 0;
    const g7 = g[7] ?? 0;
    const r = blockedV4Reason([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
    return r ? `nat64_${r}` : null;
  }
  if (first >= 0xfe80 && first <= 0xfebf) return "link_local_fe80::/10";
  if (first >= 0xfc00 && first <= 0xfdff) return "unique_local_fc00::/7";
  if (first >= 0xff00) return "multicast_ff00::/8";
  return null;
}

function blockedIpReason(host: string): string | null {
  const v4 = parseIPv4(host);
  if (v4) return blockedV4Reason(v4);
  if (host.includes(":")) return blockedV6Reason(host);
  return null;
}

/**
 * Build an SSRF guard around an injectable DNS lookup (tests pass a
 * stub; production uses node:dns/promises with `all: true`).
 * Static checks (scheme, credentials, localhost names, literal IPs)
 * never touch DNS. A lookup FAILURE returns allowed — an unresolvable
 * host is the legitimate "DEAD: dns_error" paid verdict, not a block.
 */
export function makeSsrfGuard(lookupFn: SsrfLookupFn): SsrfGuard {
  return async (rawUrl: string) => {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return { allowed: false, reason: "unparseable_url" };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { allowed: false, reason: "non_http_scheme" };
    }
    if (u.username !== "" || u.password !== "") {
      return { allowed: false, reason: "credentials_in_url" };
    }
    let host = u.hostname.toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (host.endsWith(".")) host = host.slice(0, -1);
    if (host === "" ) {
      return { allowed: false, reason: "empty_hostname" };
    }
    // Any localhost NAME (any port) → our own internal services.
    if (host === "localhost" || host.endsWith(".localhost")) {
      return { allowed: false, reason: "localhost_hostname" };
    }
    const literal = blockedIpReason(host);
    if (literal) return { allowed: false, reason: `blocked_ip_${literal}` };
    if (parseIPv4(host) !== null || host.includes(":")) {
      // Literal IP that passed the block list — public address.
      return { allowed: true };
    }
    let addrs: Array<{ address: string; family: number }>;
    try {
      addrs = await lookupFn(host);
    } catch {
      return { allowed: true }; // DNS failure → probe reports DEAD
    }
    for (const { address } of addrs) {
      const reason = blockedIpReason(address);
      if (reason) {
        return {
          allowed: false,
          reason: `resolves_to_blocked_${reason} (${address})`,
        };
      }
    }
    return { allowed: true };
  };
}

/** Production guard: full static checks + real DNS (all addresses). */
const defaultSsrfGuard = makeSsrfGuard((hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true }),
);

/**
 * DNS-less guard used inside the handler as defence-in-depth for
 * direct-invocation paths (tests, dev): all static checks, no lookup.
 * The DNS-resolution check has already run in the preflight on the
 * paid path.
 */
const staticSsrfGuard = makeSsrfGuard(async () => []);

// ─────────────────────────────────────────────────────────────────────
// Challenge classification (pure)
// ─────────────────────────────────────────────────────────────────────

export interface LivenessChecks {
  reachable: boolean;
  is_402: boolean;
  challenge_parses: boolean;
  x402_version: number | string | null;
  accepts_count: number | null;
  accepts_valid: boolean;
  price_usd_min: number | null;
  networks: string[];
  pay_to_sample: string | null;
  bazaar_extension_present: boolean;
  input_schema_declared: boolean;
  latency_over_5s: boolean;
}

export interface LivenessClassification {
  status: "ALIVE" | "DEGRADED" | "DEAD";
  reason: string;
  checks: LivenessChecks;
}

function baseChecks(): LivenessChecks {
  return {
    reachable: false,
    is_402: false,
    challenge_parses: false,
    x402_version: null,
    accepts_count: null,
    accepts_valid: false,
    price_usd_min: null,
    networks: [],
    pay_to_sample: null,
    bazaar_extension_present: false,
    input_schema_declared: false,
    latency_over_5s: false,
  };
}

function parseAtomicAmount(accept: Record<string, unknown>): number | null {
  const raw = accept["amount"] ?? accept["maxAmountRequired"];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pure classifier over the raw probe outcome. No I/O; fully
 * table-testable. `fetchError` (timeout / DNS / TLS / connect) always
 * wins as DEAD; then 5xx = DEAD; then 402-challenge grading; any
 * reachable-but-not-clean surface (or > 5 s latency) = DEGRADED.
 */
export function classifyX402Challenge(args: {
  httpStatus: number | null;
  contentType?: string | null;
  bodyText?: string | null;
  latencyMs?: number | null;
  fetchError?: string | null;
}): LivenessClassification {
  const checks = baseChecks();
  checks.latency_over_5s = (args.latencyMs ?? 0) > SLOW_LATENCY_MS;

  if (args.fetchError) {
    return { status: "DEAD", reason: args.fetchError, checks };
  }
  if (args.httpStatus === null || args.httpStatus === undefined) {
    return { status: "DEAD", reason: "no_response", checks };
  }
  checks.reachable = true;
  const httpStatus = args.httpStatus;

  if (httpStatus >= 500) {
    return { status: "DEAD", reason: `http_${httpStatus}_server_error`, checks };
  }
  if (httpStatus >= 300 && httpStatus < 400) {
    // SSRF policy: the probe NEVER follows redirects (a 302 to
    // 169.254.169.254 would bypass the pre-settle guard). A surface
    // that redirects instead of answering 402 is not a clean x402
    // surface — explicit DEGRADED.
    return {
      status: "DEGRADED",
      reason: `redirect_${httpStatus}_not_followed (probe never follows redirects; x402 surface should answer 402 directly)`,
      checks,
    };
  }
  if (httpStatus !== 402) {
    return {
      status: "DEGRADED",
      reason: `no_402_challenge (http ${httpStatus}) — may be free, POST-only, or wrong path`,
      checks,
    };
  }
  checks.is_402 = true;

  let body: unknown;
  try {
    body = JSON.parse(args.bodyText ?? "");
  } catch {
    return { status: "DEGRADED", reason: "402_body_not_json", checks };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: "DEGRADED", reason: "402_body_not_object", checks };
  }
  checks.challenge_parses = true;
  const obj = body as Record<string, unknown>;

  const version = obj["x402Version"];
  if (typeof version === "number" || typeof version === "string") {
    checks.x402_version = version;
  }
  const extensions = obj["extensions"];
  checks.bazaar_extension_present =
    typeof extensions === "object" &&
    extensions !== null &&
    (extensions as Record<string, unknown>)["bazaar"] !== undefined;

  const accepts = obj["accepts"];
  if (!Array.isArray(accepts) || accepts.length === 0) {
    checks.accepts_count = Array.isArray(accepts) ? accepts.length : null;
    return { status: "DEGRADED", reason: "missing_or_empty_accepts", checks };
  }
  checks.accepts_count = accepts.length;

  // Lenient input-schema signal: top-level input_schema or any
  // accept-level inputSchema/outputSchema declaration.
  checks.input_schema_declared =
    obj["input_schema"] !== undefined ||
    accepts.some(
      (a) =>
        typeof a === "object" &&
        a !== null &&
        ((a as Record<string, unknown>)["outputSchema"] !== undefined ||
          (a as Record<string, unknown>)["inputSchema"] !== undefined),
    );

  let allValid = true;
  const prices: number[] = [];
  const networks = new Set<string>();
  for (const entry of accepts) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      allValid = false;
      continue;
    }
    const a = entry as Record<string, unknown>;
    const scheme = a["scheme"];
    const network = a["network"];
    const payTo = a["payTo"];
    const amount = parseAtomicAmount(a);
    if (
      typeof scheme !== "string" ||
      typeof network !== "string" ||
      typeof payTo !== "string" ||
      payTo === "" ||
      amount === null
    ) {
      allValid = false;
      continue;
    }
    networks.add(network);
    prices.push(amount);
    if (checks.pay_to_sample === null) checks.pay_to_sample = payTo;
  }
  checks.networks = [...networks];
  if (prices.length > 0) {
    // Amounts are atomic USDC-style 6-decimal units → USD.
    checks.price_usd_min = Math.min(...prices) / 1e6;
  }
  checks.accepts_valid = allValid;

  if (checks.x402_version === null) {
    return { status: "DEGRADED", reason: "missing_x402Version", checks };
  }
  if (!allValid) {
    return {
      status: "DEGRADED",
      reason: "invalid_accepts_entries (need scheme+network+payTo and positive amount)",
      checks,
    };
  }
  if (checks.latency_over_5s) {
    return {
      status: "DEGRADED",
      reason: `slow_response (valid challenge but latency ${args.latencyMs}ms > ${SLOW_LATENCY_MS}ms)`,
      checks,
    };
  }
  return { status: "ALIVE", reason: "valid_x402_challenge", checks };
}

// ─────────────────────────────────────────────────────────────────────
// Response builder (four-layer)
// ─────────────────────────────────────────────────────────────────────

export function buildLivenessResponse(args: {
  resourceUrl: string;
  classification: LivenessClassification;
  httpStatus: number | null;
  latencyMs: number | null;
  server: string | null;
  contentType: string | null;
  probeMethod: ProbeMethod;
  bodyText: string | null;
  redirectLocation: string | null;
  now: Date;
}): Record<string, unknown> {
  const c = args.classification;
  const truncated =
    args.bodyText === null || args.bodyText === ""
      ? null
      : args.bodyText.slice(0, RAW_BODY_CAP);
  return {
    resource_url: args.resourceUrl,
    verdict: {
      status: c.status,
      reason: c.reason,
      checked_at: args.now.toISOString(),
    },
    signals: {
      http_status: args.httpStatus,
      latency_ms: args.latencyMs,
      x402_version: c.checks.x402_version,
      accepts_count: c.checks.accepts_count,
      accepts_valid: c.checks.accepts_valid,
      price_usd_min: c.checks.price_usd_min,
      networks: c.checks.networks,
      pay_to_sample: c.checks.pay_to_sample,
      bazaar_extension_present: c.checks.bazaar_extension_present,
      input_schema_declared: c.checks.input_schema_declared,
      server: args.server,
      content_type: args.contentType,
    },
    data_quality: {
      probe_method: args.probeMethod,
      timeout_ms: TOTAL_TIMEOUT_MS,
      // SSRF policy: probe never follows redirects; a 3xx is reported
      // as DEGRADED with the (unfollowed) Location echoed here.
      redirect_policy: "manual",
      redirect_location: args.redirectLocation,
    },
    raw: { challenge_body: truncated },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Validator / preflight / handler
// ─────────────────────────────────────────────────────────────────────

/**
 * Pre-payment validator with the discovery split (see discovery.ts):
 * missing / empty / placeholder resource_url passes through (null) so
 * the 402 challenge — with input_schema — is served to schema-blind
 * crawlers. Only a PRESENT non-placeholder value that isn't a valid
 * http(s) URL gets the 422 before the challenge. No I/O here.
 */
export const x402LivenessCheckValidator: InternalHandlerValidator = (
  body,
  _method,
) => {
  const p = parseLivenessBody(body);
  switch (p.kind) {
    case "discovery":
    case "ok":
      return null;
    case "invalid_json":
      return { status: 400, body: { error: "invalid_json_body" } };
    case "malformed":
      return {
        status: 422,
        body: {
          error: "resource_url_required",
          input_schema: x402LivenessCheckInputSchema,
        },
      };
    case "invalid_url":
      return {
        status: 422,
        body: {
          error: "invalid_resource_url",
          detail: "resource_url must be a parseable http:// or https:// URL",
          received: p.value,
          input_schema: x402LivenessCheckInputSchema,
        },
      };
    case "invalid_method":
      return {
        status: 422,
        body: {
          error: "invalid_method",
          detail: "method must be GET, POST or HEAD",
          received: p.value,
          input_schema: x402LivenessCheckInputSchema,
        },
      };
    case "invalid_request_body":
      return {
        status: 422,
        body: {
          error: "invalid_request_body",
          detail: "request_body must be a JSON object",
          input_schema: x402LivenessCheckInputSchema,
        },
      };
  }
};

/**
 * Pre-settlement gate (payment present, BEFORE settle — a rejection
 * here means the buyer is NOT charged):
 *  1. discovery-class body that somehow got paid → 422, never settle;
 *  2. SSRF guard with real DNS — blocked target → 422 blocked_target.
 * DNS failure is NOT a block (the probe's "DEAD" verdict is the paid
 * answer). A thrown error here is treated by the dispatcher as a 503
 * no-charge.
 */
export const x402LivenessCheckPreflight: InternalHandlerPreflight = async (
  input,
) => {
  const p = parseLivenessBody(input.body);
  if (p.kind !== "ok") {
    return {
      proceed: false,
      status: 422,
      body: {
        error: "invalid_resource_url",
        input_schema: x402LivenessCheckInputSchema,
      },
    };
  }
  const verdict = await defaultSsrfGuard(p.resourceUrl);
  if (!verdict.allowed) {
    return {
      proceed: false,
      status: 422,
      body: {
        error: "blocked_target",
        reason: verdict.reason ?? "blocked",
        input_schema: x402LivenessCheckInputSchema,
      },
    };
  }
  return { proceed: true };
};

export const x402LivenessCheck: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = x402LivenessCheckValidator(input.body, input.method);
  if (rejected) return rejected;
  const p = parseLivenessBody(input.body);
  if (p.kind !== "ok") {
    return {
      status: 422,
      body: {
        error: "invalid_resource_url",
        input_schema: x402LivenessCheckInputSchema,
      },
    };
  }

  // Defence-in-depth static SSRF check (no DNS — the resolution check
  // already ran in the preflight on the paid path).
  const guard = await staticSsrfGuard(p.resourceUrl);
  if (!guard.allowed) {
    return {
      status: 422,
      body: {
        error: "blocked_target",
        reason: guard.reason ?? "blocked",
        input_schema: x402LivenessCheckInputSchema,
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  const started = Date.now();
  let response: Response | null = null;
  let fetchError: string | null = null;
  let bodyText: string | null = null;
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": PROBE_UA,
    };
    const init: RequestInit = {
      method: p.method,
      headers,
      // NEVER follow: a redirect to a private/metadata target would
      // bypass the pre-settle SSRF guard. 3xx is classified explicitly.
      redirect: "manual",
      signal: controller.signal,
    };
    if (p.method === "POST") {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(p.requestBody ?? {});
    }
    // Deliberately NO payment headers: this is an unpaid probe of the
    // target's 402 surface, never a settle against it.
    response = await (input.fetchImpl ?? fetch)(p.resourceUrl, init);
  } catch (err) {
    const name = (err as Error).name;
    fetchError =
      name === "AbortError" || name === "TimeoutError"
        ? `timeout_after_${TOTAL_TIMEOUT_MS}ms`
        : `network_error: ${(err as Error).message ?? "unknown"}`;
  }
  const latencyMs = Date.now() - started;
  if (response !== null) {
    try {
      bodyText = await response.text();
    } catch {
      bodyText = null;
    }
  }
  clearTimeout(timer);

  const classification = classifyX402Challenge({
    httpStatus: response ? response.status : null,
    contentType: response?.headers.get("content-type") ?? null,
    bodyText,
    latencyMs,
    fetchError,
  });

  return {
    status: 200,
    body: buildLivenessResponse({
      resourceUrl: p.resourceUrl,
      classification,
      httpStatus: response ? response.status : null,
      latencyMs,
      server: response?.headers.get("server") ?? null,
      contentType: response?.headers.get("content-type") ?? null,
      probeMethod: p.method,
      bodyText,
      redirectLocation: response?.headers.get("location") ?? null,
      now: new Date(),
    }),
  };
};
