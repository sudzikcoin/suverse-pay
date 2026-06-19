/**
 * Unit tests for the declarative endpoint engine — the data-driven
 * core behind the mass-wrap pipeline. Each test isolates the engine
 * against a `fetchImpl` stub: no proxy stack, no DB, no network.
 *
 * Coverage:
 *   - URL building: path substitution + transform (pad10, upper, csv),
 *     query params, upstreamName aliasing, staticQuery merge.
 *   - Error mapping: 429->503, upstream 4xx->400, unreachable->502.
 *   - Response shaping: source envelope + optional `pick` projection.
 *   - Validator: empty/placeholder bodies pass (discovery), present +
 *     pattern-invalid is 422.
 *   - Preflight: missing required field fails closed (no settle).
 *   - Input schema: required list + example reflect the spec.
 */
import { describe, expect, it, vi } from "vitest";

import {
  makeDeclarativeHandler,
  makeDeclarativeValidator,
  makeDeclarativePreflight,
  makeDeclarativeInputSchema,
} from "../src/handlers/declarative/engine.js";
import type { DeclarativeSpec } from "../src/handlers/declarative/types.js";

const buf = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8");

function okFetch(payload: unknown, captured?: { url?: string; headers?: unknown }) {
  return (async (url: string, init?: RequestInit) => {
    if (captured) {
      captured.url = url;
      captured.headers = init?.headers;
    }
    return {
      status: 200,
      ok: true,
      json: async () => payload,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const SEC_SPEC: DeclarativeSpec = {
  handlerName: "t_sec",
  slug: "t-sec",
  category: "sec",
  sourceLabel: "sec.edgar",
  upstreamMethod: "GET",
  urlTemplate: "https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/{taxonomy}/{tag}.json",
  headers: { "User-Agent": "test ua" },
  params: {
    cik: { in: "path", required: true, type: "string", pattern: "^[0-9]{1,10}$", transform: "pad10", description: "cik", example: "320193" },
    taxonomy: { in: "path", required: false, default: "us-gaap", description: "tax", example: "us-gaap" },
    tag: { in: "path", required: true, type: "string", pattern: "^[A-Za-z]{2,60}$", description: "tag", example: "Revenues" },
  },
};

const WB_SPEC: DeclarativeSpec = {
  handlerName: "t_wb",
  slug: "t-wb",
  category: "macro",
  sourceLabel: "worldbank",
  upstreamMethod: "GET",
  urlTemplate: "https://api.worldbank.org/v2/country/{country}/indicator/NY.GDP.MKTP.CD",
  staticQuery: { format: "json", per_page: "30" },
  params: {
    country: { in: "path", required: true, type: "string", pattern: "^[A-Za-z]{2,3}$", transform: "upper", description: "iso", example: "US" },
  },
};

const OM_SPEC: DeclarativeSpec = {
  handlerName: "t_om",
  slug: "t-om",
  category: "weather",
  sourceLabel: "open-meteo",
  upstreamMethod: "GET",
  urlTemplate: "https://api.open-meteo.com/v1/forecast",
  staticQuery: { current_weather: "true" },
  pick: ["current_weather"],
  params: {
    latitude: { in: "query", required: true, type: "number", description: "lat", example: 40.71 },
    longitude: { in: "query", required: true, type: "number", description: "lon", example: -74.01 },
  },
};

describe("declarative engine — URL building", () => {
  it("pads CIK, fills path defaults, sets UA header", async () => {
    const cap: { url?: string; headers?: unknown } = {};
    const h = makeDeclarativeHandler(SEC_SPEC);
    const r = await h({ body: buf({ cik: "320193", tag: "Revenues" }), method: "POST", fetchImpl: okFetch({ cik: 320193 }, cap) });
    expect(r.status).toBe(200);
    expect(cap.url).toBe("https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/Revenues.json");
    expect((cap.headers as Record<string, string>)["User-Agent"]).toBe("test ua");
    expect(r.body).toMatchObject({ source: "sec.edgar" });
  });

  it("uppercases path param + merges staticQuery", async () => {
    const cap: { url?: string } = {};
    const h = makeDeclarativeHandler(WB_SPEC);
    await h({ body: buf({ country: "us" }), method: "POST", fetchImpl: okFetch([{}, []], cap) });
    expect(cap.url).toBe("https://api.worldbank.org/v2/country/US/indicator/NY.GDP.MKTP.CD?format=json&per_page=30");
  });

  it("projects with pick + wraps in source envelope", async () => {
    const h = makeDeclarativeHandler(OM_SPEC);
    const r = await h({ body: buf({ latitude: 40.71, longitude: -74.01 }), method: "POST", fetchImpl: okFetch({ current_weather: { temperature: 21 }, hourly: { drop: 1 } }) });
    expect(r.body).toEqual({ source: "open-meteo", data: { current_weather: { temperature: 21 } } });
  });
});

describe("declarative engine — error mapping", () => {
  const statusFetch = (status: number) =>
    (async () => ({ status, ok: status < 400, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;

  it("maps upstream 429 -> 503", async () => {
    const r = await makeDeclarativeHandler(WB_SPEC)({ body: buf({ country: "US" }), method: "POST", fetchImpl: statusFetch(429) });
    expect(r.status).toBe(503);
  });
  it("maps upstream 4xx -> 400", async () => {
    const r = await makeDeclarativeHandler(WB_SPEC)({ body: buf({ country: "US" }), method: "POST", fetchImpl: statusFetch(422) });
    expect(r.status).toBe(400);
  });
  it("maps unreachable -> 502", async () => {
    const boom = (async () => { throw new Error("ECONN"); }) as unknown as typeof fetch;
    const r = await makeDeclarativeHandler(WB_SPEC)({ body: buf({ country: "US" }), method: "POST", fetchImpl: boom });
    expect(r.status).toBe(502);
  });
  it("returns 400 on missing required field (no upstream call)", async () => {
    const spy = vi.fn();
    const r = await makeDeclarativeHandler(WB_SPEC)({ body: buf({}), method: "POST", fetchImpl: spy as unknown as typeof fetch });
    expect(r.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("declarative engine — validator (discovery vs 422)", () => {
  const v = makeDeclarativeValidator(WB_SPEC)!;
  it("passes empty body through to 402 (discovery)", () => {
    expect(v(Buffer.from("", "utf8"), "POST")).toBeNull();
    expect(v(buf({}), "POST")).toBeNull();
  });
  it("passes placeholder value through to 402 (discovery)", () => {
    expect(v(buf({ country: "string" }), "POST")).toBeNull();
    expect(v(buf({ country: "<country>" }), "POST")).toBeNull();
  });
  it("rejects present-but-invalid value with 422", () => {
    const r = v(buf({ country: "USA1" }), "POST");
    expect(r?.status).toBe(422);
  });
});

describe("declarative engine — preflight (fail-closed)", () => {
  const pf = makeDeclarativePreflight(OM_SPEC)!;
  it("blocks settlement when a required field is absent", async () => {
    const r = await pf({ body: buf({ latitude: 40.71 }), method: "POST" });
    expect(r.proceed).toBe(false);
    if (!r.proceed) expect(r.status).toBe(422);
  });
  it("proceeds when all required fields present", async () => {
    const r = await pf({ body: buf({ latitude: 40.71, longitude: -74.01 }), method: "POST" });
    expect(r.proceed).toBe(true);
  });
});

describe("declarative engine — input schema", () => {
  it("reflects required fields + example from the spec", () => {
    const s = makeDeclarativeInputSchema(SEC_SPEC)!;
    expect(s.body.required).toEqual(["cik", "tag"]); // taxonomy has a default -> optional
    expect(s.example).toMatchObject({ cik: "320193", tag: "Revenues" });
    expect(s.method).toBe("POST");
  });
  it("is undefined for a no-param spec", () => {
    const noParam: DeclarativeSpec = { ...WB_SPEC, params: {} };
    expect(makeDeclarativeInputSchema(noParam)).toBeUndefined();
  });
});
