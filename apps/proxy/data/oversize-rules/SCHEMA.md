# oversize-rules dataset — per-state entry schema (v1)

One JSON file per state: `data/oversize-rules/<usps>.json` (lowercase, e.g. `oh.json`).
All dimensions are **decimal feet** (14'10" → 14.83). All weights are **pounds**.
`null` means "not codified here — do not guess"; the handler surfaces it as
verify_with_state, it NEVER invents a number.

```jsonc
{
  "state": "OH",                          // USPS code, uppercase
  "state_name": "Ohio",
  "source_url": "https://…",              // official state DOT / permit-office OSOW page (REQUIRED)
  "source_title": "ODOT Special Hauling Permits",
  "portal_url": "https://…",              // where permits are actually bought (may equal source_url)
  "retrieved_at": "2026-07-15",           // when this entry was written/verified
  "rules_as_of": "2026-07-15",            // date the rules were last confirmed accurate
  "verification": "live_checked",         // "live_checked" (fetched the page this run) | "knowledge_based"
  "data_quality": "ok",                   // "ok" | "verify_with_state"
  "verify_reasons": [],                   // REQUIRED non-empty when data_quality=verify_with_state
  "legal_limits": {                       // NO permit needed at or under these
    "width_ft": 8.5,
    "height_ft": 13.5,                    // 13.5 or 14.0 by state
    "length_semitrailer_ft": 53,          // semitrailer length limit (national network default 53)
    "gross_weight_lbs": 80000
  },
  "superload_thresholds": {               // at/above ANY of these → SUPERLOAD_REVIEW
    "width_ft": 16.0,                     // null = state has no fixed published threshold
    "height_ft": 14.83,
    "length_ft": 120,
    "gross_weight_lbs": 120000,
    "note": null
  },
  "escort_rules": {                       // sorted by over_ft ascending; ranges half-open (over, up_to]
    "width":  [ { "over_ft": 12.0, "up_to_ft": 14.0, "escorts": 1, "police": false, "note": "front on 2-lane, rear on divided" },
                { "over_ft": 14.0, "up_to_ft": null, "escorts": 2, "police": false, "note": null } ],
    "height": [ { "over_ft": 14.5, "up_to_ft": null, "escorts": 1, "police": false, "pole_car": true, "note": null } ],
    "length": [ { "over_ft": 90,   "up_to_ft": null, "escorts": 1, "police": false, "note": "rear escort" } ],
    "weight": []                          // rarely used; police often kicks in via superload instead
  },
  "permit_types": {
    "single_trip": {
      "available": true,
      "fee_usd_min": 135, "fee_usd_max": 135,   // null when formula-based — set fee_formula instead
      "fee_formula": null,                      // e.g. "per-mile by axle weight: $0.04/ton-mile over legal; inputs: miles, excess tons"
      "validity_days": 5,
      "note": null
    },
    "annual": { "available": true, "fee_usd_min": 500, "fee_usd_max": 2250, "note": "blanket annual for divisible ranges" }
  },
  "movement_restrictions": [              // only clearly published rules; empty array = none codified here
    "No movement from 30 min after sunset to 30 min before sunrise",
    "No holiday travel (major holidays) for loads over legal width"
  ],
  "notes": []
}
```

Honesty rules (binding): unknown → null + verify_with_state, never a plausible-looking
invention. Escort matrices and superload thresholds vary per state — only codify what the
state actually publishes. Fees drift constantly; ranges are fine, formulas beat fake numbers.
