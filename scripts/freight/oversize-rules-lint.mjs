#!/usr/bin/env node
/**
 * oversize-rules-lint.mjs — report-only staleness + integrity check for the
 * per-state OS/OW rules dataset (apps/proxy/data/oversize-rules/*.json).
 *
 * This dataset drifts: states revise fee schedules, escort matrices and
 * superload definitions. There is no way to auto-refresh it, so this lint
 * surfaces what needs a human's attention:
 *   - entries whose rules_as_of is older than STALE_DAYS (default 180)
 *   - entries still flagged data_quality=verify_with_state (the honest
 *     backlog of states whose escort/fee specifics need point verification)
 *   - structural problems the handler's loader would also reject
 *
 * It NEVER edits anything. Intended for a monthly report-only cron that
 * pipes the summary to the ops Telegram. Exit code is always 0 unless a
 * file is structurally broken (exit 1), so a normal "things are stale"
 * run does not page anyone.
 *
 *   node scripts/freight/oversize-rules-lint.mjs [--days 180] [--json]
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(
  new URL("../../apps/proxy/data/oversize-rules/", import.meta.url),
);

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const STALE_DAYS = Number(arg("days", 180));
const asJson = arg("json", false);
// Fixed "today" is passed by the cron via OVERSIZE_LINT_TODAY so the report
// is deterministic; falls back to wall clock for ad-hoc runs.
const today = process.env.OVERSIZE_LINT_TODAY
  ? new Date(process.env.OVERSIZE_LINT_TODAY)
  : new Date();

const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const stale = [];
const verify = [];
const broken = [];
const ok = [];

for (const f of files.sort()) {
  let entry;
  try {
    entry = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
  } catch (e) {
    broken.push({ file: f, why: `unparseable: ${e.message}` });
    continue;
  }
  const problems = [];
  if (!/^[A-Z]{2}$/.test(entry.state ?? "")) problems.push("bad state code");
  if (typeof entry.source_url !== "string" || !entry.source_url.startsWith("http")) {
    problems.push("missing source_url");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.rules_as_of ?? "")) problems.push("bad rules_as_of");
  if (!entry.legal_limits || typeof entry.legal_limits.width_ft !== "number") {
    problems.push("bad legal_limits");
  }
  if (
    entry.data_quality === "verify_with_state" &&
    (entry.verify_reasons ?? []).length === 0
  ) {
    problems.push("verify_with_state without verify_reasons");
  }
  if (problems.length > 0) {
    broken.push({ file: f, why: problems.join("; ") });
    continue;
  }

  const ageDays = Math.floor(
    (today.getTime() - new Date(entry.rules_as_of).getTime()) / 86_400_000,
  );
  if (ageDays > STALE_DAYS) {
    stale.push({ state: entry.state, rules_as_of: entry.rules_as_of, age_days: ageDays });
  }
  if (entry.data_quality === "verify_with_state") {
    verify.push({ state: entry.state, reasons: entry.verify_reasons.length });
  }
  ok.push(entry.state);
}

const summary = {
  checked: files.length,
  stale_over_days: STALE_DAYS,
  stale_count: stale.length,
  verify_with_state_count: verify.length,
  broken_count: broken.length,
  stale,
  verify_backlog: verify.map((v) => v.state),
  broken,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`oversize-rules lint — ${files.length} states checked (as of ${today.toISOString().slice(0, 10)})`);
  console.log(`  stale (>${STALE_DAYS}d): ${stale.length}`);
  for (const s of stale) console.log(`    - ${s.state}: rules_as_of ${s.rules_as_of} (${s.age_days}d old)`);
  console.log(`  verify_with_state backlog: ${verify.length} — ${verify.map((v) => v.state).join(", ") || "none"}`);
  if (broken.length > 0) {
    console.log(`  BROKEN: ${broken.length}`);
    for (const b of broken) console.log(`    - ${b.file}: ${b.why}`);
  }
}

process.exit(broken.length > 0 ? 1 : 0);
