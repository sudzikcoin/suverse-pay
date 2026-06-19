#!/usr/bin/env node
/**
 * Authoring script for batch-002 — 50 free-to-wrap starred endpoints,
 * all single-hop GET no-auth (fits the declarative engine as-is, no
 * engine change => no shared-config regression risk). Emits
 * scripts/pipeline/batch-002.json which wrap-batch.mjs then consumes.
 *
 * Keeping authoring in JS (not raw JSON) lets defaults + helpers keep
 * 50 rows consistent and ASCII-clean. This is how 100/day stays sane.
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));

const UA = { "User-Agent": "SuVersePay data@suverse.io" };
const rows = [];
// mk: terse row builder. p=params, sq=staticQuery, h=headers.
const mk = (o) => {
  rows.push({
    slug: o.slug, category: o.category, source: o.source,
    title: o.title, description: o.desc, descriptionBazaar: o.bz ?? o.desc,
    tags: o.tags, priceUsdcAtomic: o.price ?? 3000,
    upstream: { url: o.url, timeoutMs: o.timeout ?? 10000, ...(o.sq ? { staticQuery: o.sq } : {}), ...(o.h ? { headers: o.h } : {}) },
    params: o.p ?? {},
    sampleRequest: o.req ?? {}, sampleResponse: o.res ?? { source: o.source, data: {} },
    ...(o.pick ? { pick: o.pick } : {}),
  });
};
const num = (d, e) => ({ in: "query", required: true, type: "number", description: d, example: e });
const qstr = (d, e, extra = {}) => ({ in: "query", required: true, type: "string", description: d, example: e, ...extra });

// ── A. FX / Frankfurter (ECB, no-key) ──────────────────────────────
mk({ slug: "suverse-fx-latest-pair", category: "forex", source: "frankfurter", price: 2000,
  title: "Latest FX Rate For A Pair", desc: "Latest ECB reference exchange rate from one currency to another via Frankfurter, no key. Returns base, date, and the converted rate. For AI agents doing reliable fiat conversion, treasury, and pricing math.",
  tags: ["forex", "fx", "exchange-rate", "ecb", "currency"], url: "https://api.frankfurter.app/latest",
  p: { from: qstr("Base currency ISO code", "USD", { pattern: "^[A-Za-z]{3}$", transform: "upper" }), to: qstr("Quote currency ISO code", "EUR", { pattern: "^[A-Za-z]{3}$", transform: "upper" }) },
  req: { from: "USD", to: "EUR" }, res: { source: "frankfurter", data: { amount: 1, base: "USD", date: "2026-06-18", rates: { EUR: 0.92 } } } });
mk({ slug: "suverse-fx-timeseries", category: "forex", source: "frankfurter", price: 3000,
  title: "FX Rate Time Series", desc: "Daily ECB reference exchange rate time series between two currencies over a date range via Frankfurter, no key. For AI agents backtesting FX, computing volatility, and charting currency trends.",
  tags: ["forex", "fx", "timeseries", "historical", "ecb"], url: "https://api.frankfurter.app/{start_date}..{end_date}",
  p: { start_date: { in: "path", required: true, type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: "Start date YYYY-MM-DD", example: "2025-01-01" },
       end_date: { in: "path", required: true, type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: "End date YYYY-MM-DD", example: "2025-01-31" },
       from: qstr("Base currency ISO code", "USD", { pattern: "^[A-Za-z]{3}$", transform: "upper" }), to: qstr("Quote currency ISO code", "EUR", { pattern: "^[A-Za-z]{3}$", transform: "upper" }) },
  req: { start_date: "2025-01-01", end_date: "2025-01-31", from: "USD", to: "EUR" }, res: { source: "frankfurter", data: { base: "USD", rates: { "2025-01-02": { EUR: 0.96 } } } } });
mk({ slug: "suverse-fx-currencies", category: "forex", source: "frankfurter", price: 2000,
  title: "Supported FX Currencies", desc: "List of currencies supported by the Frankfurter ECB rate service with full currency names, no key. For AI agents validating currency codes and building dropdowns and conversion UIs.",
  tags: ["forex", "fx", "currencies", "reference", "ecb"], url: "https://api.frankfurter.app/currencies",
  res: { source: "frankfurter", data: { USD: "United States Dollar", EUR: "Euro" } } });
mk({ slug: "suverse-fx-historical-date", category: "forex", source: "frankfurter", price: 2000,
  title: "FX Rates On A Date", desc: "ECB reference exchange rates on a specific historical date for a base currency via Frankfurter, no key. For AI agents reconciling past transactions and historical valuation.",
  tags: ["forex", "fx", "historical", "ecb", "currency"], url: "https://api.frankfurter.app/{date}",
  p: { date: { in: "path", required: true, type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: "Date YYYY-MM-DD", example: "2025-01-15" },
       from: { in: "query", required: false, type: "string", pattern: "^[A-Za-z]{3}$", transform: "upper", description: "Base currency ISO code", example: "USD" } },
  req: { date: "2025-01-15", from: "USD" }, res: { source: "frankfurter", data: { base: "USD", date: "2025-01-15", rates: { EUR: 0.95 } } } });

// ── B. Earthquakes / USGS (no-key) ─────────────────────────────────
mk({ slug: "suverse-quakes-recent", category: "science", source: "usgs", price: 3000,
  title: "Recent Earthquakes Past Day", desc: "All earthquakes detected worldwide in the past day from the USGS real time feed, no key. Returns magnitude, place, time, and coordinates per event. For AI agents in insurance, logistics, and risk monitoring.",
  tags: ["earthquakes", "usgs", "seismic", "hazards", "science"], url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
  res: { source: "usgs", data: { metadata: { count: 220 }, features: [{ properties: { mag: 4.2, place: "off coast" } }] } } });
mk({ slug: "suverse-quakes-significant", category: "science", source: "usgs", price: 3000,
  title: "Significant Earthquakes Past Month", desc: "Significant earthquakes worldwide in the past month from the USGS feed, no key. Returns magnitude, place, tsunami flag, time, and coordinates. For AI agents tracking major seismic events and disaster response.",
  tags: ["earthquakes", "usgs", "significant", "tsunami", "science"], url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson",
  res: { source: "usgs", data: { metadata: { count: 8 }, features: [{ properties: { mag: 6.5, place: "region", tsunami: 0 } }] } } });
mk({ slug: "suverse-quakes-search", category: "science", source: "usgs", price: 4000,
  title: "Earthquake Search By Magnitude", desc: "Search USGS earthquakes by minimum magnitude and optional start time, no key. Returns matching events with magnitude, place, time, and coordinates, newest first. For AI agents querying seismic history on demand.",
  tags: ["earthquakes", "usgs", "search", "seismic", "science"], url: "https://earthquake.usgs.gov/fdsnws/event/1/query",
  sq: { format: "geojson", orderby: "time", limit: "100" },
  p: { minmagnitude: num("Minimum magnitude", 4.5), starttime: { in: "query", required: false, type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: "Start date YYYY-MM-DD", example: "2026-06-01" } },
  req: { minmagnitude: 5, starttime: "2026-06-01" }, res: { source: "usgs", data: { features: [{ properties: { mag: 5.1 } }] } } });
mk({ slug: "suverse-quakes-by-region", category: "science", source: "usgs", price: 4000,
  title: "Earthquakes Near A Location", desc: "USGS earthquakes within a radius of a latitude and longitude, no key. Returns nearby events with magnitude, place, time, and distance ordering by time. For AI agents doing location specific seismic risk checks.",
  tags: ["earthquakes", "usgs", "region", "radius", "science"], url: "https://earthquake.usgs.gov/fdsnws/event/1/query",
  sq: { format: "geojson", orderby: "time", limit: "100" },
  p: { latitude: num("Latitude", 35.7), longitude: num("Longitude", -117.6), maxradiuskm: { in: "query", required: false, type: "number", description: "Max radius in km", example: 300 } },
  req: { latitude: 35.7, longitude: -117.6, maxradiuskm: 300 }, res: { source: "usgs", data: { features: [{ properties: { mag: 3.3 } }] } } });

// ── C. Academic / OpenAlex + Crossref (no-key) ─────────────────────
const oa = (slug, what, ex, url) => mk({ slug, category: "academic", source: "openalex", price: 3000,
  title: `OpenAlex ${what} Search`, desc: `Search the OpenAlex open scholarly graph for ${what.toLowerCase()} by keyword, no key. Returns ranked matches with identifiers and metadata. For AI agents doing literature review, research enrichment, and citation analysis.`,
  tags: ["academic", "openalex", "research", "papers", what.toLowerCase()], url,
  sq: { "per-page": "10", mailto: "data@suverse.io" }, p: { search: qstr(`${what} search query`, ex) }, req: { search: ex },
  res: { source: "openalex", data: { meta: { count: 1000 }, results: [{ id: "https://openalex.org/W1", display_name: ex }] } } });
oa("suverse-openalex-works", "Works", "graph neural networks", "https://api.openalex.org/works");
oa("suverse-openalex-authors", "Authors", "Yoshua Bengio", "https://api.openalex.org/authors");
oa("suverse-openalex-institutions", "Institutions", "MIT", "https://api.openalex.org/institutions");
oa("suverse-openalex-concepts", "Concepts", "machine learning", "https://api.openalex.org/concepts");
mk({ slug: "suverse-crossref-works", category: "academic", source: "crossref", price: 3000,
  title: "Crossref Works Search", desc: "Search Crossref scholarly metadata across journals, conferences, and books by query, no key. Returns matching works with DOI, title, authors, and publication. For AI agents resolving citations and enriching bibliographies.",
  tags: ["academic", "crossref", "doi", "citations", "research"], url: "https://api.crossref.org/works",
  sq: { rows: "10", mailto: "data@suverse.io" }, p: { query: qstr("Search query", "attention is all you need") },
  req: { query: "attention is all you need" }, res: { source: "crossref", data: { message: { items: [{ DOI: "10.5555/1", title: ["..."] }] } } } });
mk({ slug: "suverse-crossref-journals", category: "academic", source: "crossref", price: 3000,
  title: "Crossref Journals Search", desc: "Search Crossref for academic journals by title or keyword, no key. Returns journals with title, publisher, ISSN, and article counts. For AI agents discovering venues and validating journal identifiers.",
  tags: ["academic", "crossref", "journals", "issn", "research"], url: "https://api.crossref.org/journals",
  sq: { rows: "10" }, p: { query: qstr("Journal search query", "nature") },
  req: { query: "nature" }, res: { source: "crossref", data: { message: { items: [{ title: "Nature", ISSN: ["0028-0836"] }] } } } });

// ── D. Vehicles / NHTSA (no-key, public domain) ────────────────────
mk({ slug: "suverse-vin-decode", category: "vehicles", source: "nhtsa", price: 3000,
  title: "VIN Decode", desc: "Decode a vehicle identification number via the NHTSA vPIC service, no key. Returns make, model, year, body, engine, plant, and dozens of decoded attributes. For AI agents in automotive, insurance, fleet, and resale workflows.",
  tags: ["vehicles", "vin", "nhtsa", "automotive", "decode"], url: "https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/{vin}",
  sq: { format: "json" }, p: { vin: { in: "path", required: true, type: "string", pattern: "^[A-HJ-NPR-Za-hj-npr-z0-9]{11,17}$", transform: "upper", description: "Vehicle identification number", example: "1HGCM82633A004352" } },
  req: { vin: "1HGCM82633A004352" }, res: { source: "nhtsa", data: { Results: [{ Variable: "Make", Value: "HONDA" }] } } });
mk({ slug: "suverse-vehicle-makes", category: "vehicles", source: "nhtsa", price: 2000,
  title: "All Vehicle Makes", desc: "The full list of vehicle makes registered with NHTSA vPIC, no key. Returns make id and name for every manufacturer. For AI agents validating makes and building automotive reference data.",
  tags: ["vehicles", "makes", "nhtsa", "automotive", "reference"], url: "https://vpic.nhtsa.dot.gov/api/vehicles/getallmakes",
  sq: { format: "json" }, res: { source: "nhtsa", data: { Results: [{ Make_ID: 474, Make_Name: "HONDA" }] } } });
mk({ slug: "suverse-vehicle-models", category: "vehicles", source: "nhtsa", price: 2000,
  title: "Models For A Make", desc: "All vehicle models for a given make from NHTSA vPIC, no key. Returns model id and name for the manufacturer. For AI agents populating make and model selectors and validating vehicle data.",
  tags: ["vehicles", "models", "nhtsa", "automotive", "reference"], url: "https://vpic.nhtsa.dot.gov/api/vehicles/getmodelsformake/{make}",
  sq: { format: "json" }, p: { make: { in: "path", required: true, type: "string", pattern: "^[A-Za-z ]{2,30}$", description: "Vehicle make name", example: "honda" } },
  req: { make: "honda" }, res: { source: "nhtsa", data: { Results: [{ Model_Name: "Accord" }] } } });
mk({ slug: "suverse-vehicle-recalls", category: "vehicles", source: "nhtsa", price: 3000,
  title: "Vehicle Safety Recalls", desc: "Safety recalls for a make, model, and year from the NHTSA recalls API, no key. Returns each recall campaign with component, summary, consequence, and remedy. For AI agents in safety, insurance, and resale due diligence.",
  tags: ["vehicles", "recalls", "nhtsa", "safety", "automotive"], url: "https://api.nhtsa.gov/recalls/recallsByVehicle",
  p: { make: qstr("Vehicle make", "honda"), model: qstr("Vehicle model", "accord"), modelYear: qstr("Model year YYYY", "2015", { pattern: "^[0-9]{4}$" }) },
  req: { make: "honda", model: "accord", modelYear: "2015" }, res: { source: "nhtsa", data: { Count: 2, results: [{ Component: "AIR BAGS" }] } } });
mk({ slug: "suverse-vehicle-types", category: "vehicles", source: "nhtsa", price: 2000,
  title: "Vehicle Types For A Make", desc: "Vehicle types produced by a given make from NHTSA vPIC, no key. Returns type id and name such as passenger car or truck. For AI agents classifying vehicles by manufacturer.",
  tags: ["vehicles", "types", "nhtsa", "automotive", "reference"], url: "https://vpic.nhtsa.dot.gov/api/vehicles/GetVehicleTypesForMake/{make}",
  sq: { format: "json" }, p: { make: { in: "path", required: true, type: "string", pattern: "^[A-Za-z ]{2,30}$", description: "Vehicle make name", example: "honda" } },
  req: { make: "honda" }, res: { source: "nhtsa", data: { Results: [{ VehicleTypeName: "PASSENGER CAR" }] } } });

// ── E. Holidays / Nager.Date (no-key) ──────────────────────────────
mk({ slug: "suverse-public-holidays", category: "calendar", source: "nager", price: 2000,
  title: "Public Holidays By Country Year", desc: "Official public holidays for a country and year from Nager.Date, no key. Returns each holiday date, local and English name, and type. For AI agents scheduling, computing business days, and planning across regions.",
  tags: ["holidays", "calendar", "nager", "scheduling", "dates"], url: "https://date.nager.at/api/v3/PublicHolidays/{year}/{country}",
  p: { year: { in: "path", required: true, type: "string", pattern: "^[0-9]{4}$", description: "Year YYYY", example: "2026" }, country: { in: "path", required: true, type: "string", pattern: "^[A-Za-z]{2}$", transform: "upper", description: "ISO 2 letter country code", example: "US" } },
  req: { year: "2026", country: "US" }, res: { source: "nager", data: [{ date: "2026-07-04", name: "Independence Day" }] } });
mk({ slug: "suverse-next-holidays", category: "calendar", source: "nager", price: 2000,
  title: "Next Public Holidays", desc: "Upcoming public holidays for a country in the next year from Nager.Date, no key. Returns each holiday date and name. For AI agents reminding users and planning around upcoming closures.",
  tags: ["holidays", "calendar", "nager", "upcoming", "dates"], url: "https://date.nager.at/api/v3/NextPublicHolidays/{country}",
  p: { country: { in: "path", required: true, type: "string", pattern: "^[A-Za-z]{2}$", transform: "upper", description: "ISO 2 letter country code", example: "US" } },
  req: { country: "US" }, res: { source: "nager", data: [{ date: "2026-07-04", name: "Independence Day" }] } });
mk({ slug: "suverse-holiday-countries", category: "calendar", source: "nager", price: 2000,
  title: "Holiday Supported Countries", desc: "Countries supported by the Nager.Date public holiday service, no key. Returns country code and name for each. For AI agents validating coverage before querying holidays.",
  tags: ["holidays", "calendar", "nager", "countries", "reference"], url: "https://date.nager.at/api/v3/AvailableCountries",
  res: { source: "nager", data: [{ countryCode: "US", name: "United States" }] } });
mk({ slug: "suverse-long-weekends", category: "calendar", source: "nager", price: 2000,
  title: "Long Weekends By Country Year", desc: "Long weekends for a country and year from Nager.Date, no key. Returns each long weekend start date, end date, and day count. For AI agents in travel, retail, and staffing planning.",
  tags: ["holidays", "calendar", "nager", "travel", "long-weekend"], url: "https://date.nager.at/api/v3/LongWeekend/{year}/{country}",
  p: { year: { in: "path", required: true, type: "string", pattern: "^[0-9]{4}$", description: "Year YYYY", example: "2026" }, country: { in: "path", required: true, type: "string", pattern: "^[A-Za-z]{2}$", transform: "upper", description: "ISO 2 letter country code", example: "US" } },
  req: { year: "2026", country: "US" }, res: { source: "nager", data: [{ startDate: "2026-07-03", endDate: "2026-07-05", dayCount: 3 }] } });

// ── F. Time / TimeAPI.io (no-key) ──────────────────────────────────
mk({ slug: "suverse-time-zone", category: "time", source: "timeapi", price: 2000,
  title: "Current Time By Timezone", desc: "Current local date and time for an IANA timezone from TimeAPI.io, no key. Returns date, time, day of week, and DST flag. For AI agents scheduling and timestamping across regions.",
  tags: ["time", "timezone", "clock", "scheduling", "iana"], url: "https://timeapi.io/api/Time/current/zone",
  p: { timeZone: qstr("IANA timezone name", "America/New_York", { pattern: "^[A-Za-z]+/[A-Za-z_]+$" }) },
  req: { timeZone: "America/New_York" }, res: { source: "timeapi", data: { dateTime: "2026-06-19T08:00:00", dayOfWeek: "Friday" } } });
mk({ slug: "suverse-time-coordinate", category: "time", source: "timeapi", price: 2000,
  title: "Current Time By Coordinate", desc: "Current local date and time for a latitude and longitude from TimeAPI.io, no key. Resolves the timezone from coordinates and returns the local time and DST flag. For AI agents localizing time from a location.",
  tags: ["time", "timezone", "coordinate", "geo", "clock"], url: "https://timeapi.io/api/Time/current/coordinate",
  p: { latitude: num("Latitude", 40.71), longitude: num("Longitude", -74.01) },
  req: { latitude: 40.71, longitude: -74.01 }, res: { source: "timeapi", data: { timeZone: "America/New_York", dateTime: "2026-06-19T08:00:00" } } });
mk({ slug: "suverse-timezones-list", category: "time", source: "timeapi", price: 2000,
  title: "Available Timezones", desc: "The list of IANA timezones supported by TimeAPI.io, no key. Returns timezone names. For AI agents validating timezone input and building pickers.",
  tags: ["time", "timezone", "list", "iana", "reference"], url: "https://timeapi.io/api/TimeZone/AvailableTimeZones",
  res: { source: "timeapi", data: ["America/New_York", "Europe/London"] } });

// ── G. Domain / DNS / RDAP (no-key) ────────────────────────────────
mk({ slug: "suverse-dns-lookup", category: "network", source: "google-dns", price: 2000,
  title: "DNS Record Lookup", desc: "Resolve DNS records for a domain over Google public DNS over HTTPS, no key. Returns answers for the requested record type such as A, AAAA, MX, TXT, or NS. For AI agents in security, deliverability, and infrastructure checks.",
  tags: ["dns", "domain", "network", "lookup", "doh"], url: "https://dns.google/resolve",
  p: { name: qstr("Domain name", "example.com", { pattern: "^[a-zA-Z0-9.-]+$" }), type: { in: "query", required: false, type: "string", default: "A", enum: ["A", "AAAA", "MX", "TXT", "NS", "CNAME", "SOA"], description: "DNS record type", example: "MX" } },
  req: { name: "example.com", type: "MX" }, res: { source: "google-dns", data: { Status: 0, Answer: [{ type: 15, data: "10 mail.example.com." }] } } });
mk({ slug: "suverse-rdap-domain", category: "network", source: "rdap", price: 3000,
  title: "Domain RDAP Registration", desc: "Structured domain registration data over RDAP, the modern WHOIS replacement, no key. Returns registrar, status, nameservers, and key event dates. For AI agents doing domain due diligence, fraud checks, and asset inventory.",
  tags: ["domain", "rdap", "whois", "registration", "network"], url: "https://rdap.org/domain/{domain}",
  p: { domain: { in: "path", required: true, type: "string", pattern: "^[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$", transform: "lower", description: "Domain name", example: "example.com" } },
  req: { domain: "example.com" }, res: { source: "rdap", data: { ldhName: "EXAMPLE.COM", status: ["active"] } } });
mk({ slug: "suverse-rdap-ip", category: "network", source: "rdap", price: 3000,
  title: "IP RDAP Allocation", desc: "Structured IP address allocation data over RDAP, no key. Returns the network range, holder organization, country, and registry. For AI agents enriching IPs for security, abuse, and geolocation context.",
  tags: ["ip", "rdap", "network", "allocation", "security"], url: "https://rdap.org/ip/{ip}",
  p: { ip: { in: "path", required: true, type: "string", pattern: "^[0-9]{1,3}(\\.[0-9]{1,3}){3}$", description: "IPv4 address", example: "8.8.8.8" } },
  req: { ip: "8.8.8.8" }, res: { source: "rdap", data: { handle: "NET-8-8-8-0-1", country: "US" } } });

// ── H. Health / openFDA + RxNorm + ClinicalTrials + disease.sh ─────
const fda = (slug, what, path, ex) => mk({ slug, category: "health", source: "openfda", price: 4000,
  title: `openFDA ${what}`, desc: `Query the openFDA ${what.toLowerCase()} dataset by search expression, no key, US FDA public data. Returns matching records with structured fields. For AI agents in pharma, health, and safety research.`,
  tags: ["health", "openfda", "fda", "drugs", "safety"], url: `https://api.fda.gov/${path}.json`,
  sq: { limit: "5" }, p: { search: { in: "query", required: false, type: "string", description: "openFDA search expression", example: ex } },
  req: ex ? { search: ex } : {}, res: { source: "openfda", data: { meta: { results: { total: 100 } }, results: [{}] } } });
fda("suverse-openfda-drug-label", "Drug Labels", "drug/label", "openfda.brand_name:advil");
fda("suverse-openfda-drug-events", "Drug Adverse Events", "drug/event", "patient.drug.medicinalproduct:aspirin");
fda("suverse-openfda-drug-recalls", "Drug Recalls", "drug/enforcement", "");
fda("suverse-openfda-food-recalls", "Food Recalls", "food/enforcement", "");
fda("suverse-openfda-device-recalls", "Device Recalls", "device/enforcement", "");
mk({ slug: "suverse-rxnorm-rxcui", category: "health", source: "rxnorm", price: 3000,
  title: "RxNorm RxCUI Lookup", desc: "Resolve a drug name to its RxNorm concept identifier RxCUI from the NIH RxNav service, no key. Returns the RxCUI list for the name. For AI agents normalizing medication names across systems.",
  tags: ["health", "rxnorm", "drugs", "rxcui", "nih"], url: "https://rxnav.nlm.nih.gov/REST/rxcui.json",
  p: { name: qstr("Drug name", "ibuprofen") }, req: { name: "ibuprofen" }, res: { source: "rxnorm", data: { idGroup: { rxnormId: ["5640"] } } } });
mk({ slug: "suverse-rxnorm-drugs", category: "health", source: "rxnorm", price: 3000,
  title: "RxNorm Drug Products", desc: "Drug products related to a name from the NIH RxNav RxNorm service, no key. Returns concept groups with product names and RxCUIs. For AI agents enumerating formulations and strengths of a medication.",
  tags: ["health", "rxnorm", "drugs", "products", "nih"], url: "https://rxnav.nlm.nih.gov/REST/drugs.json",
  p: { name: qstr("Drug name", "ibuprofen") }, req: { name: "ibuprofen" }, res: { source: "rxnorm", data: { drugGroup: { conceptGroup: [{ tty: "SBD" }] } } } });
mk({ slug: "suverse-clinicaltrials-search", category: "health", source: "clinicaltrials", price: 4000,
  title: "Clinical Trials Search", desc: "Search ClinicalTrials.gov studies by term via the official v2 API, no key. Returns matching studies with NCT id, title, status, and conditions. For AI agents in clinical research, pharma intelligence, and patient matching.",
  tags: ["health", "clinical-trials", "research", "pharma", "studies"], url: "https://clinicaltrials.gov/api/v2/studies",
  sq: { pageSize: "10", format: "json" }, p: { "query.term": qstr("Search term", "diabetes") }, req: { "query.term": "diabetes" },
  res: { source: "clinicaltrials", data: { studies: [{ protocolSection: { identificationModule: { nctId: "NCT00000000" } } }] } } });
mk({ slug: "suverse-clinicaltrials-study", category: "health", source: "clinicaltrials", price: 3000,
  title: "Clinical Trial By NCT Id", desc: "Full record for a single ClinicalTrials.gov study by NCT identifier via the v2 API, no key. Returns the protocol, status, sponsors, eligibility, and outcomes. For AI agents deep reading a specific trial.",
  tags: ["health", "clinical-trials", "nct", "pharma", "studies"], url: "https://clinicaltrials.gov/api/v2/studies/{nctId}",
  sq: { format: "json" }, p: { nctId: { in: "path", required: true, type: "string", pattern: "^NCT[0-9]{8}$", transform: "upper", description: "NCT identifier", example: "NCT04280705" } },
  req: { nctId: "NCT04280705" }, res: { source: "clinicaltrials", data: { protocolSection: { identificationModule: { nctId: "NCT04280705" } } } } });
mk({ slug: "suverse-disease-covid-country", category: "health", source: "disease.sh", price: 2000,
  title: "COVID Stats By Country", desc: "COVID-19 case statistics for a country from the disease.sh aggregator, no key. Returns cases, deaths, recovered, active, tests, and per million metrics. For AI agents in public health dashboards and risk context.",
  tags: ["health", "covid", "disease", "public-health", "stats"], url: "https://disease.sh/v3/covid-19/countries/{country}",
  p: { country: { in: "path", required: true, type: "string", pattern: "^[A-Za-z ]{2,40}$", description: "Country name or ISO code", example: "USA" } },
  req: { country: "USA" }, res: { source: "disease.sh", data: { country: "USA", cases: 100000000, deaths: 1100000 } } });

// ── I. Space / science / energy (no-key, reliable substitutes for the
//     chronically-down SpaceX community API caught by probe-batch) ───
mk({ slug: "suverse-eonet-events", category: "science", source: "nasa-eonet", price: 3000,
  title: "NASA Natural Event Tracker", desc: "Open natural events worldwide from NASA EONET, no key, including wildfires, severe storms, volcanoes, and floods. Returns each event with title, category, date, and coordinates. For AI agents monitoring natural hazards and earth observation.",
  tags: ["science", "nasa", "eonet", "natural-disasters", "hazards"], url: "https://eonet.gsfc.nasa.gov/api/v3/events",
  sq: { limit: "20", status: "open" }, res: { source: "nasa-eonet", data: { events: [{ title: "Wildfire", categories: [{ title: "Wildfires" }] }] } } });
mk({ slug: "suverse-uk-carbon-intensity", category: "energy", source: "carbonintensity", price: 2000,
  title: "UK Grid Carbon Intensity", desc: "Current Great Britain electricity grid carbon intensity from the official Carbon Intensity API, no key. Returns forecast and actual gCO2 per kWh and an intensity index. For AI agents scheduling compute for lower carbon and energy analytics.",
  tags: ["energy", "carbon", "grid", "emissions", "sustainability"], url: "https://api.carbonintensity.org.uk/intensity",
  res: { source: "carbonintensity", data: { data: [{ intensity: { actual: 180, forecast: 175, index: "moderate" } }] } } });
mk({ slug: "suverse-pubchem-compound", category: "science", source: "pubchem", price: 3000,
  title: "PubChem Compound Properties", desc: "Chemical properties for a compound by name from the NIH PubChem service, no key. Returns molecular formula, molecular weight, and IUPAC name. For AI agents in chemistry, drug discovery, and materials research.",
  tags: ["science", "chemistry", "pubchem", "compounds", "nih"], url: "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{name}/property/MolecularFormula,MolecularWeight,IUPACName/JSON",
  p: { name: { in: "path", required: true, type: "string", pattern: "^[A-Za-z0-9 ,-]{2,60}$", description: "Compound name", example: "aspirin" } },
  req: { name: "aspirin" }, res: { source: "pubchem", data: { PropertyTable: { Properties: [{ MolecularFormula: "C9H8O4", MolecularWeight: "180.16" }] } } } });
mk({ slug: "suverse-worldbank-country", category: "macro", source: "worldbank", price: 2000,
  title: "World Bank Country Profile", desc: "Country profile from World Bank Open Data by ISO code, no key. Returns region, income level, capital city, longitude, and latitude. For AI agents enriching country context for macro and geo analysis.",
  tags: ["macro", "worldbank", "country", "reference", "economy"], url: "https://api.worldbank.org/v2/country/{country}",
  sq: { format: "json" }, p: { country: { in: "path", required: true, type: "string", pattern: "^[A-Za-z]{2,3}$", transform: "upper", description: "ISO 2 or 3 letter country code", example: "US" } },
  req: { country: "US" }, res: { source: "worldbank", data: [{ page: 1 }, [{ name: "United States", region: { value: "North America" }, incomeLevel: { value: "High income" } }]] } });
mk({ slug: "suverse-iss-position", category: "space", source: "wheretheiss", price: 2000,
  title: "ISS Live Position", desc: "The live position of the International Space Station from the wheretheiss.at service, no key. Returns latitude, longitude, altitude, velocity, and timestamp. For AI agents tracking the ISS and computing passes.",
  tags: ["space", "iss", "satellite", "tracking", "live"], url: "https://api.wheretheiss.at/v1/satellites/25544",
  res: { source: "wheretheiss", data: { latitude: 12.3, longitude: 45.6, altitude: 420, velocity: 27600 } } });

// ── J. Knowledge / Wikipedia (no-key, UA required) ─────────────────
mk({ slug: "suverse-wiki-summary", category: "knowledge", source: "wikipedia", price: 2000,
  title: "Wikipedia Page Summary", desc: "Concise summary of an English Wikipedia article by title via the REST API, no key. Returns the extract, description, thumbnail, and canonical URL. For AI agents grounding answers and enriching entities with encyclopedic context.",
  tags: ["knowledge", "wikipedia", "encyclopedia", "summary", "reference"], url: "https://en.wikipedia.org/api/rest_v1/page/summary/{title}", h: UA,
  p: { title: { in: "path", required: true, type: "string", pattern: "^.{1,120}$", description: "Article title", example: "Bitcoin" } },
  req: { title: "Bitcoin" }, res: { source: "wikipedia", data: { title: "Bitcoin", extract: "Bitcoin is a decentralized digital currency..." } } });
mk({ slug: "suverse-wiki-search", category: "knowledge", source: "wikipedia", price: 2000,
  title: "Wikipedia Search", desc: "Full text search of English Wikipedia via the MediaWiki API, no key. Returns ranked page titles, snippets, and word counts for the query. For AI agents finding the right article before fetching a summary.",
  tags: ["knowledge", "wikipedia", "search", "encyclopedia", "reference"], url: "https://en.wikipedia.org/w/api.php", h: UA,
  sq: { action: "query", list: "search", format: "json" }, p: { srsearch: qstr("Search query", "ethereum blockchain") },
  req: { srsearch: "ethereum blockchain" }, res: { source: "wikipedia", data: { query: { search: [{ title: "Ethereum", snippet: "..." }] } } } });
mk({ slug: "suverse-wiki-on-this-day", category: "knowledge", source: "wikipedia", price: 2000,
  title: "Wikipedia On This Day", desc: "Notable historical events, births, deaths, and holidays for a given month and day from Wikipedia, no key. Returns dated entries with descriptions and related pages. For AI agents building on this day content and trivia.",
  tags: ["knowledge", "wikipedia", "history", "on-this-day", "events"], url: "https://en.wikipedia.org/api/rest_v1/feed/onthisday/all/{month}/{day}", h: UA,
  p: { month: { in: "path", required: true, type: "string", pattern: "^(0?[1-9]|1[0-2])$", description: "Month 1-12", example: "07" }, day: { in: "path", required: true, type: "string", pattern: "^(0?[1-9]|[12][0-9]|3[01])$", description: "Day 1-31", example: "04" } },
  req: { month: "07", day: "04" }, res: { source: "wikipedia", data: { events: [{ year: 1776, text: "US Declaration of Independence" }] } } });

// ── K. Geo utilities (no-key) ──────────────────────────────────────
mk({ slug: "suverse-geocode-place", category: "geo", source: "open-meteo", price: 2000,
  title: "Place Name Geocoding", desc: "Geocode a place name to coordinates via the Open-Meteo geocoding service, no key. Returns ranked matches with latitude, longitude, country, admin region, and population. For AI agents turning place names into coordinates for downstream lookups.",
  tags: ["geo", "geocoding", "places", "coordinates", "search"], url: "https://geocoding-api.open-meteo.com/v1/search",
  sq: { count: "5", language: "en", format: "json" }, p: { name: qstr("Place name", "Paris") },
  req: { name: "Paris" }, res: { source: "open-meteo", data: { results: [{ name: "Paris", latitude: 48.85, longitude: 2.35, country: "France" }] } } });
mk({ slug: "suverse-elevation", category: "geo", source: "open-meteo", price: 2000,
  title: "Elevation By Coordinate", desc: "Ground elevation in meters for a latitude and longitude via the Open-Meteo elevation service, no key. Returns the elevation for the point. For AI agents in mapping, terrain, drone, and outdoor planning use cases.",
  tags: ["geo", "elevation", "terrain", "coordinates", "mapping"], url: "https://api.open-meteo.com/v1/elevation",
  p: { latitude: num("Latitude", 27.99), longitude: num("Longitude", 86.92) },
  req: { latitude: 27.99, longitude: 86.92 }, res: { source: "open-meteo", data: { elevation: [8729] } } });
mk({ slug: "suverse-zip-lookup", category: "geo", source: "zippopotam", price: 2000,
  title: "Postal Code Lookup", desc: "Resolve a postal code to its place names, state, and coordinates via Zippopotam, no key. Returns places with city, state, latitude, and longitude. For AI agents validating addresses and enriching postal codes.",
  tags: ["geo", "postal-code", "zip", "places", "address"], url: "https://api.zippopotam.us/{country}/{zip}",
  p: { country: { in: "path", required: false, type: "string", default: "us", pattern: "^[a-zA-Z]{2}$", transform: "lower", description: "ISO 2 letter country code", example: "us" }, zip: { in: "path", required: true, type: "string", pattern: "^[A-Za-z0-9 -]{3,10}$", description: "Postal code", example: "90210" } },
  req: { country: "us", zip: "90210" }, res: { source: "zippopotam", data: { "post code": "90210", places: [{ "place name": "Beverly Hills", state: "California" }] } } });

writeFileSync(resolve(__dirname, "batch-002.json"), JSON.stringify(rows, null, 2));
console.log(`authored ${rows.length} rows -> scripts/pipeline/batch-002.json`);
