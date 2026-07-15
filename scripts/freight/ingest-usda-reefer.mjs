#!/usr/bin/env node
/**
 * ingest-usda-reefer.mjs — weekly USDA AMS "Specialty Crops National
 * Truck Rate Report" (FVWTRK) into Postgres for the reefer-rate-report
 * endpoint.
 *
 * Source: https://www.ams.usda.gov/mnreports/fvwtrk.pdf — keyless,
 * public domain, refreshed weekly (Tuesday data). The MARS API serves
 * the same series as JSON but requires an interactively-issued key
 * (my.marketnews account); when USDA_MARS_KEY exists this script can be
 * upgraded to prefer it — until then the PDF is parsed with
 * pdftotext -layout (poppler, present on the host).
 *
 * Output: one structured JSON document in freight_http_cache under key
 * `usda:fvwtrk:v1` — { report_date, fetched_at, regions: [{ region,
 * last_report, commodities, lanes: [{ destination, availability,
 * rate_low_usd, rate_high_usd, mostly_low_usd, mostly_high_usd,
 * pct_change_wow }] }] }. Run daily from cron (cheap); the handler
 * fail-closes if the stored report is older than 9 days.
 *
 *   node scripts/freight/ingest-usda-reefer.mjs [--file <local.pdf>]
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../apps/proxy/anchor.js", import.meta.url));
const { Pool } = require("pg");

const PDF_URL = "https://www.ams.usda.gov/mnreports/fvwtrk.pdf";
const UA = "Mozilla/5.0 (compatible; SuVerse-GovHub/1.0; sudzikgroup@gmail.com)";
const CACHE_KEY = "usda:fvwtrk:v1";

const AVAILABILITY = "(Surplus|Slight Surplus|Adequate|Slight Shortage|Shortage)";
const LANE_RE = new RegExp(
  `^\\s+([A-Z][A-Za-z.\\- ]+?)\\s{2,}${AVAILABILITY}\\s+([\\d,]+)-([\\d,]+)(?:\\s+([\\d,]+)-([\\d,]+))?\\s+\\(([+-]?\\d+)\\)\\s*$`,
);
const SKIP_RE =
  /TRUCK RATE REPORT|FVWTRK|USDA|PRICES FOR|PERCENTAGE OF|^ *Page|Agricultural Marketing|Market News|Email us|Washington, DC|Phone \(|mymarketnews|RANGE|MOSTLY/;

const num = (s) => Number(String(s).replace(/,/g, ""));

// "LETTUCE, ICEBERG, LETTUCE, ROMAINE, PARSLEY AND SPINACH" — commas
// separate items BUT also qualify lettuce varieties, and the last two
// items are joined by AND. Reattach variety qualifiers to LETTUCE and
// split the trailing AND.
const LETTUCE_VARIETIES = new Set(["BOSTON", "GREEN LEAF", "ICEBERG", "RED LEAF", "ROMAINE"]);

export function splitCommodities(buf) {
  const rough = buf.split(",").map((c) => c.trim()).filter(Boolean);
  const items = [];
  for (const piece of rough) {
    const parts = piece.split(/\s+AND\s+/).map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
      if (LETTUCE_VARIETIES.has(part) && items[items.length - 1]?.startsWith("LETTUCE")) {
        if (items[items.length - 1] === "LETTUCE") {
          items[items.length - 1] = `LETTUCE (${part})`;
        } else {
          items.push(`LETTUCE (${part})`);
        }
      } else {
        items.push(part);
      }
    }
  }
  return items;
}

export function parseFvwtrk(text) {
  const lines = text.split("\n");
  // Report date: "FRUIT AND VEGETABLE TRUCK RATE REPORT FOR TUESDAY JULY 14, 2026"
  const dateLine = lines.find((l) => /TRUCK RATE REPORT FOR/i.test(l));
  let reportDate = null;
  if (dateLine) {
    const m = /FOR\s+\w+\s+([A-Z]+)\s+(\d{1,2}),?\s+(\d{4})/i.exec(dateLine);
    if (m) {
      const months = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];
      const mi = months.indexOf(m[1].toUpperCase());
      if (mi >= 0) {
        reportDate = `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
      }
    }
  }

  // Only parse the PRICES section (page 1 is a color-grid duplicate).
  const startIdx = lines.findIndex((l) => /^\s*PRICES FOR/.test(l));
  const body = startIdx === -1 ? lines : lines.slice(startIdx);

  const regions = [];
  let current = null;
  let commodityBuf = null;
  for (const line of body) {
    const t = line.trimEnd();
    const trimmed = t.trim();
    if (trimmed === "") {
      if (commodityBuf !== null && current !== null) {
        current.commodities.push(...splitCommodities(commodityBuf));
        commodityBuf = null;
      }
      continue;
    }
    if (trimmed === "LAST REPORT") {
      if (current) current.last_report = true;
      continue;
    }
    if (trimmed.startsWith("--")) {
      commodityBuf = (commodityBuf === null ? "" : commodityBuf + ", ") + trimmed.replace(/^--/, "");
      continue;
    }
    if (commodityBuf !== null && /^[A-Z, ]+$/.test(trimmed) && !SKIP_RE.test(t)) {
      // wrapped commodity continuation line
      commodityBuf += " " + trimmed;
      continue;
    }
    const lane = LANE_RE.exec(t);
    if (lane && current) {
      current.lanes.push({
        destination: lane[1].trim(),
        availability: lane[2],
        rate_low_usd: num(lane[3]),
        rate_high_usd: num(lane[4]),
        mostly_low_usd: lane[5] ? num(lane[5]) : null,
        mostly_high_usd: lane[6] ? num(lane[6]) : null,
        pct_change_wow: Number(lane[7]),
      });
      continue;
    }
    // Region header: indented ALL-CAPS line that is none of the above.
    if (/^\s{1,4}[A-Z]/.test(line) && trimmed === trimmed.toUpperCase() && !SKIP_RE.test(t) && /[A-Z]{4}/.test(trimmed)) {
      current = { region: trimmed, last_report: false, commodities: [], lanes: [] };
      regions.push(current);
      commodityBuf = null;
    }
  }
  return {
    report_date: reportDate,
    regions: regions.filter((r) => r.lanes.length > 0),
  };
}

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = readFileSync("/etc/suverse-pay/proxy.env", "utf8");
  return /^DATABASE_URL=(.+)$/m.exec(env)[1].trim();
}

async function main() {
  const fileIdx = process.argv.indexOf("--file");
  const dir = mkdtempSync(join(tmpdir(), "fvwtrk-"));
  const pdfPath = join(dir, "fvwtrk.pdf");
  try {
    if (fileIdx !== -1) {
      writeFileSync(pdfPath, readFileSync(process.argv[fileIdx + 1]));
    } else {
      const res = await fetch(PDF_URL, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`fvwtrk.pdf HTTP ${res.status}`);
      writeFileSync(pdfPath, Buffer.from(await res.arrayBuffer()));
    }
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = parseFvwtrk(text);
    if (parsed.regions.length < 3) {
      throw new Error(
        `parse produced only ${parsed.regions.length} regions — format changed? keeping previous data`,
      );
    }
    const doc = { ...parsed, source: PDF_URL, fetched_at: new Date().toISOString() };
    const pool = new Pool({ connectionString: databaseUrl(), max: 1 });
    await pool.query(
      `INSERT INTO freight_http_cache (cache_key, payload, fetched_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (cache_key) DO UPDATE
         SET payload = EXCLUDED.payload, fetched_at = EXCLUDED.fetched_at`,
      [CACHE_KEY, JSON.stringify(doc)],
    );
    await pool.end();
    const lanes = parsed.regions.reduce((a, r) => a + r.lanes.length, 0);
    console.log(
      `[${new Date().toISOString()}] fvwtrk ok: report_date=${parsed.report_date}, regions=${parsed.regions.length}, lanes=${lanes}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
