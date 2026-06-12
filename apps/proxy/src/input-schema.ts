/**
 * Per-config input-schema validation for proxied / OATP-wrapped
 * endpoints (Task 57, migration 037).
 *
 * The aggregated first-party endpoints (crypto-market-pulse,
 * wallet-reputation, token-check) never charge a buyer for a request
 * they cannot serve: hand-written validators + preflights run BEFORE
 * runProtocol() settles. Proxied endpoints had no equivalent — the
 * buyer paid, the upstream 400'd, the buyer kept the loss. This
 * module ports the philosophy to arbitrary `seller_proxy_configs`
 * rows via an optional `input_schema` jsonb column.
 *
 * Decision table — deliberately identical in spirit to
 * `handlers/discovery.ts` (commit 0e4ff10), because catalog crawlers
 * probe paid endpoints with empty or placeholder bodies and MUST see
 * the 402 challenge (price + input_schema), not a 422:
 *
 *   empty / missing / placeholder-only body
 *     → DISCOVERY. Unpaid: serve the 402 challenge. Paid: 422 before
 *       settlement (the buyer was about to pay for a guaranteed
 *       upstream 4xx — stop them, never charge).
 *   present + schema-valid
 *     → normal flow (402 challenge, or settle + serve).
 *   present + schema-invalid
 *     → 4xx before the 402 / before settlement, never charges.
 *
 * Configs with input_schema = NULL (or an unusable schema value)
 * keep the exact pre-Task-57 behavior.
 */

import { isPlaceholderValue } from "./handlers/discovery.js";

/** Property types the minimal schema dialect understands. */
export type ProxyInputSchemaType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array";

export interface ProxyInputSchemaProperty {
  type?: ProxyInputSchemaType;
  /** Regex (string-typed fields only). Invalid patterns are skipped. */
  pattern?: string;
  enum?: (string | number)[];
  minLength?: number;
  maxLength?: number;
  description?: string;
}

export interface ProxyInputSchema {
  type: "object";
  required?: string[];
  properties?: Record<string, ProxyInputSchemaProperty>;
}

/**
 * Parse the raw jsonb column value into a usable schema, or null.
 * Fail-open by design: a seller who saves a malformed schema must not
 * brick their endpoint — null means "validate nothing", same as the
 * column being NULL.
 */
export function parseProxyInputSchema(raw: unknown): ProxyInputSchema | null {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return null;
  }
  if (Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj["type"] !== "object") return null;
  const required = Array.isArray(obj["required"])
    ? (obj["required"] as unknown[]).filter(
        (f): f is string => typeof f === "string" && f.length > 0,
      )
    : [];
  const propsRaw = obj["properties"];
  const properties: Record<string, ProxyInputSchemaProperty> = {};
  if (
    propsRaw !== null &&
    typeof propsRaw === "object" &&
    !Array.isArray(propsRaw)
  ) {
    for (const [name, p] of Object.entries(
      propsRaw as Record<string, unknown>,
    )) {
      if (p === null || typeof p !== "object" || Array.isArray(p)) continue;
      properties[name] = p as ProxyInputSchemaProperty;
    }
  }
  if (required.length === 0 && Object.keys(properties).length === 0) {
    // Nothing to validate against — treat as no schema.
    return null;
  }
  return { type: "object", required, properties };
}

export type InputSchemaVerdict =
  /** No body / placeholder-only — serve the 402 challenge if unpaid. */
  | { kind: "discovery" }
  /** Real-but-wrong input. Reject pre-settle with `status` + `body`. */
  | { kind: "invalid"; status: 400 | 422; body: Record<string, unknown> }
  | { kind: "valid" };

/**
 * Classify a raw request body against a parsed config schema.
 * Mirrors `classifyRequiredBase58Field` for the generic case.
 */
export function classifyBodyAgainstSchema(
  body: Buffer | null,
  schema: ProxyInputSchema,
): InputSchemaVerdict {
  if (!body || body.length === 0 || body.toString("utf8").trim() === "") {
    return { kind: "discovery" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return {
      kind: "invalid",
      status: 400,
      body: { error: "invalid_json_body" },
    };
  }
  if (parsed === null) return { kind: "discovery" };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      kind: "invalid",
      status: 422,
      body: {
        error: "invalid_request_body",
        detail: "request body must be a JSON object",
      },
    };
  }
  const obj = parsed as Record<string, unknown>;
  const required = schema.required ?? [];
  const properties = schema.properties ?? {};

  const problems: string[] = [];
  const missing: string[] = [];
  let usableRequired = 0;

  for (const field of required) {
    const value = obj[field];
    const state = classifyValue(value, properties[field]);
    if (state === "absent") {
      missing.push(field);
    } else if (state === "ok") {
      usableRequired += 1;
    } else {
      problems.push(`${field}: ${state.detail}`);
    }
  }

  // Declared-but-optional properties still validate when present with
  // a real value — a buyer who sends `{"limit": "ten"}` against
  // `limit: {type: "number"}` is making a real (wrong) attempt.
  for (const [field, prop] of Object.entries(properties)) {
    if (required.includes(field)) continue;
    if (!(field in obj)) continue;
    const state = classifyValue(obj[field], prop);
    if (state !== "absent" && state !== "ok") {
      problems.push(`${field}: ${state.detail}`);
    }
  }

  if (problems.length > 0) {
    return {
      kind: "invalid",
      status: 422,
      body: { error: "invalid_request_body", detail: problems.join("; ") },
    };
  }
  if (missing.length > 0) {
    // No usable required value at all → a schema-blind probe poking
    // with {} / placeholders. Some usable values but others missing →
    // a real attempt that forgot a field; 422 helps it self-correct.
    if (usableRequired === 0) return { kind: "discovery" };
    return {
      kind: "invalid",
      status: 422,
      body: {
        error: "missing_required_fields",
        missing,
      },
    };
  }
  return { kind: "valid" };
}

type ValueState = "absent" | "ok" | { detail: string };

/**
 * One field's state. "absent" covers undefined, null, and placeholder
 * strings ("string", "<wallet>", "YOUR_ADDRESS"...) — the same values
 * `handlers/discovery.ts` treats as discovery-probe filler.
 */
function classifyValue(
  value: unknown,
  prop: ProxyInputSchemaProperty | undefined,
): ValueState {
  if (value === undefined || value === null) return "absent";
  // Placeholder strings count as absent — unless the schema's enum
  // explicitly allows the word (e.g. enum: ["test", "live"]), in
  // which case it's a legitimate value, not probe filler.
  const enumAllows =
    prop !== undefined &&
    Array.isArray(prop.enum) &&
    (prop.enum as unknown[]).includes(value);
  if (typeof value === "string" && isPlaceholderValue(value) && !enumAllows) {
    return "absent";
  }
  if (!prop) return "ok";

  if (prop.type !== undefined && !matchesType(value, prop.type)) {
    return { detail: `expected type ${prop.type}` };
  }
  if (typeof value === "string") {
    if (
      typeof prop.minLength === "number" &&
      value.length < prop.minLength
    ) {
      return { detail: `shorter than minLength ${prop.minLength}` };
    }
    if (
      typeof prop.maxLength === "number" &&
      value.length > prop.maxLength
    ) {
      return { detail: `longer than maxLength ${prop.maxLength}` };
    }
    if (typeof prop.pattern === "string") {
      let re: RegExp | null = null;
      try {
        re = new RegExp(prop.pattern);
      } catch {
        // Seller saved an invalid regex — skip the constraint rather
        // than rejecting every buyer (fail-open, like parse above).
        re = null;
      }
      if (re !== null && !re.test(value)) {
        return { detail: `does not match pattern ${prop.pattern}` };
      }
    }
  }
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const allowed = prop.enum as unknown[];
    if (!allowed.includes(value)) {
      return { detail: `must be one of ${JSON.stringify(prop.enum)}` };
    }
  }
  return "ok";
}

function matchesType(value: unknown, type: ProxyInputSchemaType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
  }
}
