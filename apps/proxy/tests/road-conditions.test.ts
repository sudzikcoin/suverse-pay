import { describe, expect, it } from "vitest";
import {
  parseLatLon,
  haversineKm,
  corridorPoints,
  distanceToCorridorKm,
  parseRouteQuery,
  computeRoadVerdict,
  extractWorkZones,
  roadConditions,
  roadConditionsPreflight,
  roadConditionsValidator,
  type NwsAlert,
  type WorkZoneEvent,
} from "../src/handlers/road-conditions.js";
import type { DbQuerier, InternalHandlerInput } from "../src/handlers/types.js";

const NOW = new Date("2026-07-15T12:00:00Z");
const CHI = { lat: 41.8781, lon: -87.6298 };
const ATL = { lat: 33.749, lon: -84.388 };

function buf(v: unknown): Buffer {
  return Buffer.from(JSON.stringify(v), "utf8");
}

function alert(over: Partial<NwsAlert>): NwsAlert {
  return {
    id: Math.random().toString(36),
    event: "Special Weather Statement",
    severity: "Minor",
    urgency: "Expected",
    headline: null,
    area: null,
    onset: null,
    ends: null,
    sender: null,
    ...over,
  };
}

function wz(over: Partial<WorkZoneEvent>): WorkZoneEvent {
  return {
    road_names: ["I-65"],
    direction: "southbound",
    vehicle_impact: "some-lanes-closed",
    description: null,
    start_date: null,
    end_date: null,
    state: "indiana",
    distance_from_corridor_km: 2,
    ...over,
  };
}

describe("geometry", () => {
  it("parses lat,lon strings and rejects garbage", () => {
    expect(parseLatLon("41.88,-87.63")).toEqual({ lat: 41.88, lon: -87.63 });
    expect(parseLatLon(" 33.7 , -84.4 ")).toEqual({ lat: 33.7, lon: -84.4 });
    expect(parseLatLon("Chicago, IL")).toBeNull();
    expect(parseLatLon("91,-87")).toBeNull();
  });
  it("computes plausible distances and corridors", () => {
    const d = haversineKm(CHI, ATL);
    expect(d).toBeGreaterThan(900);
    expect(d).toBeLessThan(1000);
    const pts = corridorPoints(CHI, ATL);
    expect(pts.length).toBeGreaterThanOrEqual(8);
    expect(pts.length).toBeLessThanOrEqual(25);
    expect(pts[0]!.lat).toBeCloseTo(CHI.lat, 5);
    expect(pts[0]!.lon).toBeCloseTo(CHI.lon, 5);
    expect(pts[pts.length - 1]!.lat).toBeCloseTo(ATL.lat, 5);
  });
  it("measures distance to the corridor", () => {
    const corridor = corridorPoints(CHI, ATL);
    expect(distanceToCorridorKm(CHI, corridor)).toBeLessThan(1);
    // Indianapolis is roughly on the way; Denver is not.
    expect(distanceToCorridorKm({ lat: 39.77, lon: -86.16 }, corridor)).toBeLessThan(60);
    expect(
      distanceToCorridorKm({ lat: 39.74, lon: -104.99 }, corridor),
    ).toBeGreaterThan(1000);
  });
});

describe("parseRouteQuery / validator", () => {
  it("discovery for empty and placeholder bodies", () => {
    expect(parseRouteQuery(null).kind).toBe("discovery");
    expect(parseRouteQuery(buf({})).kind).toBe("discovery");
    expect(parseRouteQuery(buf({ origin: "string", destination: "string" })).kind).toBe(
      "discovery",
    );
    expect(roadConditionsValidator(buf({}), "POST")).toBeNull();
  });
  it("requires both endpoints once one is real", () => {
    const r = roadConditionsValidator(buf({ origin: "Chicago, IL" }), "POST");
    expect(r?.status).toBe(422);
  });
  it("accepts aliases", () => {
    const p = parseRouteQuery(buf({ from: "41.88,-87.63", to: "Atlanta, GA" }));
    expect(p.kind).toBe("query");
  });
});

describe("computeRoadVerdict", () => {
  it("CLEAR with nothing", () => {
    expect(computeRoadVerdict([], []).status).toBe("CLEAR");
  });
  it("SEVERE on extreme alerts, severe winter warnings, or full closures", () => {
    expect(computeRoadVerdict([alert({ severity: "Extreme" })], []).status).toBe("SEVERE");
    expect(
      computeRoadVerdict(
        [alert({ severity: "Severe", event: "Blizzard Warning" })],
        [],
      ).status,
    ).toBe("SEVERE");
    expect(
      computeRoadVerdict([], [wz({ vehicle_impact: "all-lanes-closed" })]).status,
    ).toBe("SEVERE");
  });
  it("CAUTION on advisories, lane closures, or dense work zones", () => {
    expect(
      computeRoadVerdict([alert({ severity: "Moderate", event: "Heat Advisory" })], [])
        .status,
    ).toBe("CAUTION");
    expect(computeRoadVerdict([], [wz({})]).status).toBe("CAUTION");
    const dense = Array.from({ length: 10 }, () => wz({ vehicle_impact: null }));
    expect(computeRoadVerdict([], dense).status).toBe("CAUTION");
  });
});

describe("extractWorkZones", () => {
  const corridor = corridorPoints(CHI, ATL);
  const feed = (features: unknown[]) => ({ features });
  const indyEvent = (over: Record<string, unknown> = {}) => ({
    properties: {
      core_details: {
        event_type: "work-zone",
        road_names: ["I-65"],
        direction: "southbound",
      },
      vehicle_impact: "some-lanes-closed",
      start_date: "2026-07-01T00:00:00Z",
      end_date: "2026-08-01T00:00:00Z",
      ...over,
    },
    geometry: { type: "LineString", coordinates: [[-86.7, 39.8], [-86.72, 39.78]] },
  });

  it("keeps active on-corridor work zones", () => {
    const zones = extractWorkZones(feed([indyEvent()]), "indiana", corridor, NOW);
    expect(zones.length).toBe(1);
    expect(zones[0]!.road_names).toEqual(["I-65"]);
    expect(zones[0]!.distance_from_corridor_km).toBeLessThan(60);
  });
  it("drops ended, far-future, and off-corridor events", () => {
    const ended = indyEvent({ end_date: "2026-07-01T00:00:00Z" });
    const future = indyEvent({ start_date: "2026-09-01T00:00:00Z" });
    const denver = {
      ...indyEvent(),
      geometry: { type: "Point", coordinates: [-104.99, 39.74] },
    };
    expect(extractWorkZones(feed([ended, future, denver]), "x", corridor, NOW)).toEqual([]);
  });
  it("survives malformed feeds", () => {
    expect(extractWorkZones({ nope: 1 }, "x", corridor, NOW)).toEqual([]);
    expect(extractWorkZones(feed([{ properties: null, geometry: null }]), "x", corridor, NOW)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// e2e with stubbed fetch + db cache
// ─────────────────────────────────────────────────────────────────────

function makeDbStub(): DbQuerier {
  return {
    async query(text: string) {
      // freight_http_cache only: SELECT misses, INSERT no-ops.
      if (text.includes("freight_http_cache")) return { rows: [] };
      return { rows: [] };
    },
  };
}

interface FetchOpts {
  nwsDown?: boolean;
  geocodeEmpty?: boolean;
  alertsFeatures?: unknown[];
}

function makeFetchStub(opts: FetchOpts = {}): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (u.includes("nominatim")) {
      if (opts.geocodeEmpty) return json([]);
      if (u.includes("Chicago")) {
        return json([{ lat: "41.8781", lon: "-87.6298", display_name: "Chicago, Cook County, Illinois" }]);
      }
      return json([{ lat: "33.749", lon: "-84.388", display_name: "Atlanta, Fulton County, Georgia" }]);
    }
    if (u.includes("/alerts/active")) {
      if (opts.nwsDown) return json({ detail: "down" }, 503);
      return json({
        features:
          opts.alertsFeatures ?? [
            {
              properties: {
                id: "urn:x:1",
                event: "Heat Advisory",
                severity: "Moderate",
                urgency: "Expected",
                headline: "Heat Advisory until 8 PM",
                areaDesc: "Cook County",
                onset: "2026-07-15T10:00:00-05:00",
                ends: "2026-07-15T20:00:00-05:00",
                senderName: "NWS Chicago",
              },
            },
          ],
      });
    }
    if (u.includes("/points/")) {
      return json({
        properties: { relativeLocation: { properties: { state: "IN" } } },
      });
    }
    if (u.includes("69qe-yiui")) {
      return json([
        {
          state: "indiana",
          feedname: "incars",
          format: "geojson",
          active: true,
          version: "4.1",
          url: { url: "https://example.test/in/wzdx" },
        },
        {
          state: "colorado",
          feedname: "cdot",
          active: true,
          needapikey: true,
          version: "4.2",
          url: { url: "https://example.test/co/wzdx" },
        },
      ]);
    }
    if (u.includes("example.test/in/wzdx")) {
      return json({
        features: [
          {
            properties: {
              core_details: { event_type: "work-zone", road_names: ["I-65"] },
              vehicle_impact: "all-lanes-closed",
              start_date: "2026-07-01T00:00:00Z",
              end_date: "2026-08-01T00:00:00Z",
            },
            geometry: { type: "Point", coordinates: [-86.7, 39.8] },
          },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
}

function makeInput(body: unknown, opts: FetchOpts = {}): InternalHandlerInput {
  return {
    body: buf(body),
    method: "POST",
    db: makeDbStub(),
    fetchImpl: makeFetchStub(opts),
  };
}

describe("preflight + handler e2e", () => {
  it("produces a corridor verdict with honest coverage", async () => {
    const inp = makeInput({ origin: "Chicago, IL", destination: "Atlanta, GA" });
    const pf = await roadConditionsPreflight(inp);
    expect(pf.proceed).toBe(true);
    const res = await roadConditions({
      ...inp,
      preflightData: (pf as { proceed: true; data?: unknown }).data,
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    // A full closure on I-65 near Indianapolis → SEVERE.
    expect(body["verdict"]["status"]).toBe("SEVERE");
    expect(body["work_zones"]["all_lanes_closed"]).toBe(1);
    expect(body["weather"]["total_alerts"]).toBe(1);
    expect(body["route"]["states_crossed"]).toEqual(["IN"]);
    expect(body["coverage"]["wzdx"]["states_with_live_feed"]).toEqual(["indiana"]);
    expect(body["route"]["distance_km"]).toBeGreaterThan(900);
  });

  it("accepts raw coordinates without geocoding", async () => {
    const inp = makeInput({ origin: "41.8781,-87.6298", destination: "33.749,-84.388" });
    const pf = await roadConditionsPreflight(inp);
    expect(pf.proceed).toBe(true);
  });

  it("422s unresolvable places pre-settlement", async () => {
    const inp = makeInput(
      { origin: "Nowhereville Zzz", destination: "Atlanta, GA" },
      { geocodeEmpty: true },
    );
    const pf = await roadConditionsPreflight(inp);
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(422);
  });

  it("fails closed when NWS is down", async () => {
    const inp = makeInput(
      { origin: "41.8781,-87.6298", destination: "33.749,-84.388" },
      { nwsDown: true },
    );
    const pf = await roadConditionsPreflight(inp);
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(503);
  });

  it("422s absurd routes", async () => {
    const inp = makeInput({ origin: "41.88,-87.63", destination: "41.88,-87.63" });
    const pf = await roadConditionsPreflight(inp);
    expect(pf.proceed).toBe(false);
    expect((pf as { status?: number }).status).toBe(422);
  });
});
