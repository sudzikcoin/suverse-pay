/**
 * Declarative handler engine. Turns a `DeclarativeSpec` (pure data)
 * into the three things the proxy registry consumes:
 *
 *   makeDeclarativeHandler(spec)     -> InternalHandler
 *   makeDeclarativeValidator(spec)   -> InternalHandlerValidator | undefined
 *   makeDeclarativeInputSchema(spec) -> InternalHandlerInputSchema | undefined
 *
 * The handler runs the same flow every bespoke fetch-handler hand-codes
 * today (parse body -> build upstream GET -> map errors -> shape), but
 * driven entirely by the spec, so wrapping a new upstream is a data
 * edit. Error mapping mirrors the conventions in the existing handlers
 * (e.g. frankfurter-rates-batch.ts): 429->503, 4xx->400, !ok->502,
 * abort->504, bad json->502.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerPreflight,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "../types.js";
import type { InternalHandlerInputSchema } from "../discovery.js";
import { isPlaceholderValue } from "../discovery.js";
import type { DeclarativeParam, DeclarativeSpec } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

function applyTransform(value: unknown, t: DeclarativeParam["transform"]): string {
  let s: string;
  if (Array.isArray(value)) {
    s = value.map((v) => String(v)).join(",");
  } else {
    s = String(value);
  }
  switch (t) {
    case "upper":
      return s.toUpperCase();
    case "lower":
      return s.toLowerCase();
    case "csv":
      return s; // arrays already joined above
    case "pad10":
      return s.replace(/\D/g, "").padStart(10, "0").slice(-10);
    case "identity":
    case undefined:
    default:
      return s;
  }
}

/** Coerce + validate one body value against its param spec. Returns the
 *  string to place in the URL, or an error result to serve verbatim. */
function resolveParam(
  field: string,
  spec: DeclarativeParam,
  raw: unknown,
): { value: string } | { error: InternalHandlerResult } {
  let v = raw;
  if (v === undefined || v === null || v === "") {
    if (spec.default !== undefined) v = spec.default;
    else if (spec.required)
      return { error: { status: 400, body: { error: "missing_required_field", field } } };
    else return { value: "" }; // optional+absent → caller drops it
  }
  if (spec.type === "number" || spec.type === "integer") {
    const n = typeof v === "number" ? v : Number(String(v));
    if (!Number.isFinite(n))
      return { error: { status: 400, body: { error: "invalid_number", field } } };
    if (spec.type === "integer" && !Number.isInteger(n))
      return { error: { status: 400, body: { error: "expected_integer", field } } };
    return { value: String(n) };
  }
  if (spec.type === "array" && !Array.isArray(v) && spec.transform === "csv") {
    // allow a single scalar too
  }
  const str = applyTransform(v, spec.transform);
  if (spec.enum && !spec.enum.includes(str))
    return { error: { status: 400, body: { error: "invalid_enum_value", field, allowed: spec.enum } } };
  if (spec.pattern && !new RegExp(spec.pattern).test(str))
    return { error: { status: 400, body: { error: "pattern_mismatch", field } } };
  return { value: str };
}

export function makeDeclarativeHandler(spec: DeclarativeSpec): InternalHandler {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (input: InternalHandlerInput): Promise<InternalHandlerResult> => {
    let parsed: unknown;
    try {
      parsed =
        input.body && input.body.length > 0
          ? JSON.parse(input.body.toString("utf8"))
          : {};
    } catch {
      return { status: 400, body: { error: "invalid_json_body" } };
    }
    if (parsed === null) parsed = {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: 400, body: { error: "body_must_be_object" } };
    }
    const obj = parsed as Record<string, unknown>;

    // Build URL: path substitutions first, then query string.
    let url = spec.urlTemplate;
    const query = new URLSearchParams();
    for (const [field, pspec] of Object.entries(spec.params)) {
      const res = resolveParam(field, pspec, obj[field]);
      if ("error" in res) return res.error;
      if (res.value === "" && !pspec.required && pspec.default === undefined) continue;
      if (pspec.in === "path") {
        url = url.replace(`{${field}}`, encodeURIComponent(res.value));
      } else {
        query.set(pspec.upstreamName ?? field, res.value);
      }
    }
    for (const [k, val] of Object.entries(spec.staticQuery ?? {})) query.set(k, val);
    const qs = query.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await (input.fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: { accept: "application/json", ...(spec.headers ?? {}) },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError")
        return { status: 504, body: { error: "upstream_timeout" } };
      return { status: 502, body: { error: "upstream_unreachable" } };
    }
    clearTimeout(timer);

    if (response.status === 429)
      return { status: 503, body: { error: "rate_limit_upstream" } };
    if (response.status === 404)
      return { status: 404, body: { error: "not_found_upstream" } };
    if (response.status >= 400 && response.status < 500)
      return { status: 400, body: { error: "upstream_rejected", upstreamStatus: response.status } };
    if (!response.ok)
      return { status: 502, body: { error: "upstream_error", upstreamStatus: response.status } };

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { status: 502, body: { error: "upstream_invalid_json" } };
    }

    if (spec.pick && data && typeof data === "object" && !Array.isArray(data)) {
      const src = data as Record<string, unknown>;
      const picked: Record<string, unknown> = {};
      for (const k of spec.pick) if (k in src) picked[k] = src[k];
      data = picked;
    }

    return { status: 200, body: { source: spec.sourceLabel, data } };
  };
}

/** Required string params are the ones we gate on pre-payment. */
function requiredStringParams(spec: DeclarativeSpec): Array<[string, DeclarativeParam]> {
  return Object.entries(spec.params).filter(
    ([, p]) =>
      p.required &&
      p.default === undefined &&
      (p.type === undefined || p.type === "string"),
  );
}

/**
 * Pre-payment validator mirroring handlers/discovery.ts: empty /
 * placeholder bodies pass through to the 402 challenge (so crawlers
 * read the price + input_schema), while a present-but-malformed value
 * is rejected 422 before any settlement. Endpoints with no required
 * string field get no validator (pure discovery).
 */
export function makeDeclarativeValidator(
  spec: DeclarativeSpec,
): InternalHandlerValidator | undefined {
  const gated = requiredStringParams(spec);
  if (gated.length === 0) return undefined;
  return (body: Buffer | null): InternalHandlerResult | null => {
    if (!body || body.length === 0 || body.toString("utf8").trim() === "") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return { status: 422, body: { error: "invalid_json_body" } };
    }
    if (parsed === null) return null;
    if (typeof parsed !== "object" || Array.isArray(parsed))
      return { status: 422, body: { error: "body_must_be_object" } };
    const obj = parsed as Record<string, unknown>;
    for (const [field, pspec] of gated) {
      const v = obj[field];
      // Absent / non-string / placeholder → discovery probe, serve 402.
      if (typeof v !== "string") continue;
      if (isPlaceholderValue(v)) continue;
      const t = applyTransform(v, pspec.transform);
      if (pspec.enum && !pspec.enum.includes(t))
        return { status: 422, body: { error: "invalid_enum_value", field, allowed: pspec.enum } };
      if (pspec.pattern && !new RegExp(pspec.pattern).test(t))
        return { status: 422, body: { error: "pattern_mismatch", field } };
    }
    return null;
  };
}

/**
 * Pre-SETTLEMENT gate. Runs only when a payment header is present,
 * AFTER the cheap validator but BEFORE on-chain settlement. Where the
 * validator is string-shape-only and lets discovery probes through,
 * THIS re-checks every required field (including numeric ones) against
 * the actual paying body and refuses to settle when the handler could
 * not possibly succeed — so a paying agent is never charged for a body
 * missing required fields. Endpoints with no required params get no
 * preflight (nothing to fail-closed on).
 */
export function makeDeclarativePreflight(
  spec: DeclarativeSpec,
): InternalHandlerPreflight | undefined {
  const required = Object.entries(spec.params).filter(
    ([, p]) => p.required && p.default === undefined,
  );
  if (required.length === 0) return undefined;
  return async (input: InternalHandlerInput) => {
    let parsed: unknown = {};
    try {
      parsed =
        input.body && input.body.length > 0
          ? JSON.parse(input.body.toString("utf8"))
          : {};
    } catch {
      return { proceed: false, status: 422, body: { error: "invalid_json_body" } };
    }
    if (parsed === null) parsed = {};
    if (typeof parsed !== "object" || Array.isArray(parsed))
      return { proceed: false, status: 422, body: { error: "body_must_be_object" } };
    const obj = parsed as Record<string, unknown>;
    for (const [field, pspec] of required) {
      const raw = obj[field];
      const absent =
        raw === undefined ||
        raw === null ||
        raw === "" ||
        (typeof raw === "string" && isPlaceholderValue(raw));
      if (absent)
        return {
          proceed: false,
          status: 422,
          body: { error: "missing_required_field", field, hint: pspec.description },
        };
      const res = resolveParam(field, pspec, raw);
      if ("error" in res)
        return { proceed: false, status: 422, body: res.error.body };
    }
    return { proceed: true };
  };
}

/** Machine-readable contract attached to the 402 challenge. */
export function makeDeclarativeInputSchema(
  spec: DeclarativeSpec,
): InternalHandlerInputSchema | undefined {
  const entries = Object.entries(spec.params);
  if (entries.length === 0) return undefined;
  const properties: InternalHandlerInputSchema["body"]["properties"] = {};
  const required: string[] = [];
  const example: Record<string, unknown> = {};
  for (const [field, p] of entries) {
    properties[field] = {
      type: p.type ?? "string",
      description: p.description,
      ...(p.pattern ? { pattern: p.pattern } : {}),
    };
    if (p.required && p.default === undefined) required.push(field);
    example[field] = p.example;
  }
  return {
    method: "POST",
    content_type: "application/json",
    body: { type: "object", required, properties },
    example,
  };
}
