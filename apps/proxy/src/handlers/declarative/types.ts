/**
 * Declarative endpoint specs — the data contract that lets us wrap a
 * free/cheap upstream API behind a paid x402 endpoint WITHOUT writing
 * a bespoke handler per endpoint. One `DeclarativeSpec` fully describes
 * how to turn the buyer's POST JSON body into an upstream GET call and
 * shape the response back.
 *
 * The batch pipeline (`scripts/pipeline/wrap-batch.mjs`) generates an
 * array of these from the discovery-map rows; `engine.ts` turns each
 * spec into an `InternalHandler` (+ optional validator + input schema)
 * registered once in `handlers/registry.ts`. Adding 100 endpoints/day
 * is therefore appending 100 data objects, not writing 100 functions.
 *
 * Only single-hop GET upstreams are modeled here on purpose — that
 * covers the no-auth public-data firehose (Treasury, World Bank, SEC,
 * Open-Meteo, NVD, NWS, MLB, TheSportsDB). Multi-hop / POST / auth'd
 * upstreams still get a bespoke handler.
 */

/** Transform applied to a body value before it enters the upstream URL. */
export type ParamTransform =
  | "identity"
  | "upper"
  | "lower"
  | "csv" // array -> comma-joined string
  | "pad10"; // left-pad numeric string to 10 chars (SEC CIK)

export interface DeclarativeParam {
  /** Where the value goes in the upstream request. */
  in: "query" | "path";
  /** Upstream param name (query) — defaults to the body field name. */
  upstreamName?: string;
  /** A missing required field with no default → 400 (after the 402). */
  required?: boolean;
  type?: "string" | "number" | "integer" | "boolean" | "array";
  /** Regex source string; validated cheaply pre-payment for required string fields. */
  pattern?: string;
  enum?: string[];
  /** Used when the body omits the field. */
  default?: string | number | boolean;
  transform?: ParamTransform;
  /** Human description surfaced in the 402 input_schema. */
  description: string;
  /** Example value surfaced in the 402 input_schema. */
  example: unknown;
}

export interface DeclarativeSpec {
  /** Registry key === seller_proxy_configs.internal_handler. */
  handlerName: string;
  /** Public slug (== /v1/data/<slug>); kept for traceability. */
  slug: string;
  category: string;
  /** Short upstream label echoed in the response envelope `source`. */
  sourceLabel: string;

  upstreamMethod: "GET";
  /** May contain `{field}` placeholders filled from `path` params. */
  urlTemplate: string;
  headers?: Record<string, string>;
  timeoutMs?: number;

  /** Keyed by BODY field name the buyer sends. */
  params: Record<string, DeclarativeParam>;
  /** Always-appended query params (e.g. format=json). */
  staticQuery?: Record<string, string>;

  /**
   * Optional top-level field projection on the upstream JSON. When the
   * upstream returns an object and `pick` is set, only those keys are
   * forwarded. Omit to pass the whole upstream payload through.
   */
  pick?: string[];
}
