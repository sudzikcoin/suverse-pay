/**
 * Crypto Fear & Greed Index backed by alternative.me's free,
 * no-auth `fng` endpoint. Buyer pays the proxy ($0.005), then
 * we return the current score (0-100), classification string,
 * and the last 30 days of history.
 *
 * alternative.me returns timestamps as strings — we coerce to
 * numbers on the way out so an agent doesn't have to parseInt.
 * The classification text is canonical ("Extreme Fear", "Fear",
 * "Neutral", "Greed", "Extreme Greed") — kept verbatim.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface FngEntry {
  value?: string;
  value_classification?: string;
  timestamp?: string;
  time_until_update?: string;
}

interface FngResponse {
  name?: string;
  data?: FngEntry[];
  metadata?: { error?: string | null };
}

const TIMEOUT_MS = 10_000;

export const fearGreedIndex: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  if (input.body && input.body.length > 0) {
    try {
      JSON.parse(input.body.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_json_body" } };
    }
  }

  const url = "https://api.alternative.me/fng/?limit=30&format=json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      return { status: 504, body: { error: "upstream_timeout" } };
    }
    return { status: 502, body: { error: "upstream_unreachable" } };
  }
  clearTimeout(timer);

  if (response.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (!response.ok) {
    return { status: 502, body: { error: "upstream_error", upstreamStatus: response.status } };
  }

  let data: FngResponse;
  try {
    data = (await response.json()) as FngResponse;
  } catch {
    return { status: 502, body: { error: "upstream_invalid_json" } };
  }
  if (data.metadata?.error) {
    return {
      status: 502,
      body: { error: "upstream_signaled_error", message: data.metadata.error },
    };
  }
  const entries = Array.isArray(data.data) ? data.data : [];
  if (entries.length === 0) {
    return { status: 502, body: { error: "no_data" } };
  }

  const historical = entries.map((e) => ({
    value: e.value ? Number.parseInt(e.value, 10) : null,
    classification: e.value_classification ?? null,
    timestamp: e.timestamp ? Number.parseInt(e.timestamp, 10) : null,
  }));
  const current = historical[0]!;
  const nextUpdateSeconds = entries[0]?.time_until_update
    ? Number.parseInt(entries[0].time_until_update, 10)
    : null;

  return {
    status: 200,
    body: {
      current_value: current.value,
      classification: current.classification,
      timestamp: current.timestamp,
      next_update_seconds: nextUpdateSeconds,
      window_days: historical.length,
      historical,
    },
  };
};
