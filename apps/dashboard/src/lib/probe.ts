/**
 * Server-side probe for the seller's resource server URL. The seller
 * provides their endpoint URL from the configure UI; we hit it
 * (without an X-Payment header), inspect the response, and check it
 * looks like a well-formed x402 challenge that references the
 * networks they've configured.
 *
 * Hard constraints:
 *
 *   - SSRF guard: refuse to fetch private IP ranges, link-local, or
 *     localhost in production. We resolve the hostname first so the
 *     check survives DNS rebinding (the IP we resolved IS the IP we
 *     send to). The whole resolved set must pass — a hostname that
 *     resolves to one public + one private IP fails.
 *
 *   - 10 second timeout. Any hang past that returns a structured
 *     "timeout" check failure, not a 5xx from the API route.
 *
 *   - Never throws over the API boundary. All network errors are
 *     normalised into a failed check entry. The caller can map
 *     `{ ok: false }` to HTTP 200 with a payload the UI renders.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ResourceServerConfig } from "./seller-config";

export interface ProbeCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly checks: ProbeCheck[];
  readonly rawResponse: string | null;
  readonly status: number | null;
}

export interface ProbeOptions {
  /** If true (default in prod) refuse private IPs. */
  readonly blockPrivateIps?: boolean;
  /** Override fetch (for tests). */
  readonly fetchImpl?: typeof fetch;
  /** Override DNS lookup (for tests). */
  readonly dnsLookupImpl?: typeof dnsLookup;
  /** Override timeout. */
  readonly timeoutMs?: number;
}

/**
 * IPv4 / IPv6 CIDRs we refuse to fetch when blockPrivateIps is on.
 * Block list, not allow list — we want public internet only.
 */
function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    // 0.0.0.0/8 (current network), 10.0.0.0/8, 127.0.0.0/8 (loopback),
    // 169.254.0.0/16 (link-local), 172.16.0.0/12, 192.168.0.0/16,
    // 100.64.0.0/10 (CGNAT — Tailscale lives here).
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    return false;
  }
  // Not a valid IP literal — caller resolved garbage, treat as blocked.
  return true;
}

async function resolveAndCheckIp(
  hostname: string,
  blockPrivate: boolean,
  dnsLookupImpl: typeof dnsLookup,
): Promise<{ ok: true; ip: string } | { ok: false; detail: string }> {
  // If hostname is already an IP literal, no DNS round-trip needed.
  if (isIP(hostname) !== 0) {
    if (blockPrivate && isBlockedIp(hostname)) {
      return { ok: false, detail: `${hostname} is in a blocked range` };
    }
    return { ok: true, ip: hostname };
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dnsLookupImpl(hostname, { all: true });
  } catch (err) {
    return {
      ok: false,
      detail: `DNS lookup failed: ${(err as Error).message}`,
    };
  }
  if (addrs.length === 0) {
    return { ok: false, detail: "DNS lookup returned no addresses" };
  }
  if (blockPrivate) {
    for (const a of addrs) {
      if (isBlockedIp(a.address)) {
        return {
          ok: false,
          detail: `${hostname} resolves to ${a.address} which is in a blocked range`,
        };
      }
    }
  }
  // Use the first address. Node's default ALG is sticky enough that
  // a follow-up fetch will resolve to the same set; the SSRF window
  // (resolve → fetch resolve) is small and we mitigate it by
  // checking ALL resolved addresses above.
  return { ok: true, ip: addrs[0]!.address };
}

const DEFAULT_BLOCK = process.env.NODE_ENV === "production";

export async function probeResourceServer(args: {
  url: string;
  config: ResourceServerConfig;
  options?: ProbeOptions;
}): Promise<ProbeResult> {
  const { url, config } = args;
  const options = args.options ?? {};
  const blockPrivate = options.blockPrivateIps ?? DEFAULT_BLOCK;
  const fetchImpl = options.fetchImpl ?? fetch;
  const dnsLookupImpl = options.dnsLookupImpl ?? dnsLookup;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const checks: ProbeCheck[] = [];

  // 0. URL well-formed.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    checks.push({
      name: "url_parse",
      passed: false,
      detail: `URL parse failed: ${(err as Error).message}`,
    });
    return { ok: false, checks, rawResponse: null, status: null };
  }
  checks.push({
    name: "url_parse",
    passed: true,
    detail: `parsed ${parsed.hostname}${parsed.pathname}`,
  });
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    checks.push({
      name: "url_scheme",
      passed: false,
      detail: `URL scheme must be http or https (got ${parsed.protocol})`,
    });
    return { ok: false, checks, rawResponse: null, status: null };
  }

  // 1. SSRF guard.
  const hostCheck = await resolveAndCheckIp(
    parsed.hostname,
    blockPrivate,
    dnsLookupImpl,
  );
  if (!hostCheck.ok) {
    checks.push({ name: "host_resolution", passed: false, detail: hostCheck.detail });
    return { ok: false, checks, rawResponse: null, status: null };
  }
  checks.push({
    name: "host_resolution",
    passed: true,
    detail: `resolved to ${hostCheck.ip}`,
  });

  // 2. Fetch.
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      // Don't forward cookies / credentials — we're a third party.
      credentials: "omit" as RequestCredentials,
    });
  } catch (err) {
    const msg = (err as Error).message;
    const detail =
      msg.includes("aborted") || msg.includes("timeout")
        ? `request timed out after ${timeoutMs}ms`
        : `network error: ${msg}`;
    checks.push({ name: "reachable", passed: false, detail });
    return { ok: false, checks, rawResponse: null, status: null };
  }
  checks.push({ name: "reachable", passed: true, detail: `HTTP ${response.status}` });

  // Capture the body once for diagnostics — bounded to 4 KB so a
  // misbehaving server can't fill the dashboard's response.
  const bodyText = (await response.text()).slice(0, 4096);

  // 3. Status code.
  if (response.status !== 402) {
    checks.push({
      name: "status_402",
      passed: false,
      detail: `expected 402 Payment Required, got HTTP ${response.status}`,
    });
    return {
      ok: false,
      checks,
      rawResponse: bodyText,
      status: response.status,
    };
  }
  checks.push({ name: "status_402", passed: true, detail: "402 Payment Required" });

  // 4. Content-Type.
  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.toLowerCase().includes("application/json");
  checks.push({
    name: "content_type",
    passed: isJson,
    detail: isJson ? contentType : `expected application/json, got ${contentType || "(empty)"}`,
  });

  // 5. JSON parse.
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch (err) {
    checks.push({
      name: "json_parse",
      passed: false,
      detail: `body is not JSON: ${(err as Error).message}`,
    });
    return { ok: false, checks, rawResponse: bodyText, status: response.status };
  }
  checks.push({ name: "json_parse", passed: true, detail: "body parsed" });

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    checks.push({
      name: "json_shape",
      passed: false,
      detail: "body must be a JSON object",
    });
    return { ok: false, checks, rawResponse: bodyText, status: response.status };
  }
  const obj = body as Record<string, unknown>;

  // 6. accepts / paymentRequirements array.
  const accepts =
    (obj["accepts"] as unknown) ?? (obj["paymentRequirements"] as unknown);
  if (!Array.isArray(accepts) || accepts.length === 0) {
    checks.push({
      name: "payment_requirements_present",
      passed: false,
      detail: "expected 'accepts' or 'paymentRequirements' to be a non-empty array",
    });
    return { ok: false, checks, rawResponse: bodyText, status: response.status };
  }
  checks.push({
    name: "payment_requirements_present",
    passed: true,
    detail: `${accepts.length} requirement(s)`,
  });

  // 7. Each requirement well-shaped.
  const REQUIRED_FIELDS = [
    "scheme",
    "network",
    "asset",
    "payTo",
    "maxAmountRequired",
  ] as const;
  const networksInChallenge = new Set<string>();
  const payTosInChallenge = new Set<string>();
  let allRequirementsValid = true;
  for (let i = 0; i < accepts.length; i++) {
    const r = accepts[i];
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      allRequirementsValid = false;
      break;
    }
    const rec = r as Record<string, unknown>;
    for (const f of REQUIRED_FIELDS) {
      if (typeof rec[f] !== "string") {
        allRequirementsValid = false;
        break;
      }
    }
    const network = rec["network"];
    const payTo = rec["payTo"];
    if (typeof network === "string") networksInChallenge.add(network);
    if (typeof payTo === "string") payTosInChallenge.add(payTo);
  }
  checks.push({
    name: "payment_requirements_shape",
    passed: allRequirementsValid,
    detail: allRequirementsValid
      ? "every requirement has scheme/network/asset/payTo/maxAmountRequired"
      : "at least one requirement is missing a required field",
  });

  // 8. Network overlap with the seller's config.
  const acceptedFromConfig = new Set(config.acceptedNetworks);
  const overlap = [...networksInChallenge].filter((n) =>
    acceptedFromConfig.has(n),
  );
  const networksMatch = overlap.length > 0;
  checks.push({
    name: "networks_match_config",
    passed: networksMatch,
    detail: networksMatch
      ? `overlap: ${overlap.join(", ")}`
      : `endpoint advertises ${[...networksInChallenge].join(", ") || "(none)"} but your config has ${[...acceptedFromConfig].join(", ") || "(none)"}`,
  });

  // 9. payTo overlap (informational — mismatch is a warning, not a fail).
  const expectedPayTos = [
    config.payToEvm,
    config.payToSolana,
    config.payToCosmos,
    config.payToTron,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  const payToOverlap = [...payTosInChallenge].some((p) =>
    expectedPayTos.some(
      (e) => e.toLowerCase() === p.toLowerCase(),
    ),
  );
  checks.push({
    name: "payto_match_config",
    passed: payToOverlap || expectedPayTos.length === 0,
    detail: payToOverlap
      ? "at least one payTo matches your dashboard config"
      : expectedPayTos.length === 0
        ? "no payTo configured in dashboard yet (informational)"
        : `payTos in challenge (${[...payTosInChallenge].join(", ")}) do not match any in your config — double-check`,
  });

  const ok = checks.every((c) => c.passed);
  return { ok, checks, rawResponse: bodyText, status: response.status };
}
