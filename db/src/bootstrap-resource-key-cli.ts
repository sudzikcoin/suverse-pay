#!/usr/bin/env tsx
import pg from "pg";
import { createResourceKey } from "./resource-keys.js";

interface ParsedArgs {
  label: string;
  rateLimit: number;
  monthlyCap: number | null;
  metadata: Record<string, unknown>;
}

function parseArgs(argv: string[]): ParsedArgs {
  let label = "";
  let rateLimit = 60;
  let monthlyCap: number | null = null;
  let metadata: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--label") {
      label = argv[++i] ?? "";
    } else if (arg === "--rate-limit") {
      rateLimit = Number(argv[++i]);
    } else if (arg === "--monthly-cap") {
      const v = argv[++i];
      if (v === "null" || v === "unlimited" || v === undefined) {
        monthlyCap = null;
      } else {
        monthlyCap = Number(v);
      }
    } else if (arg === "--metadata") {
      const raw = argv[++i] ?? "{}";
      metadata = JSON.parse(raw);
    }
  }
  if (label.length === 0) {
    throw new Error(
      "usage: bootstrap-resource-key --label <label> [--rate-limit N=60] [--monthly-cap N|null] [--metadata '{...}']",
    );
  }
  if (!Number.isFinite(rateLimit) || rateLimit <= 0) {
    throw new Error(`--rate-limit must be a positive integer, got ${rateLimit}`);
  }
  if (monthlyCap !== null && (!Number.isFinite(monthlyCap) || monthlyCap < 0)) {
    throw new Error(`--monthly-cap must be a non-negative integer or "null", got ${monthlyCap}`);
  }
  return { label, rateLimit, monthlyCap, metadata };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }
  const args = parseArgs(process.argv.slice(2));
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const created = await createResourceKey({
      client: pool,
      label: args.label,
      rateLimitPerMinute: args.rateLimit,
      monthlySettleCap: args.monthlyCap,
      metadata: args.metadata,
    });

    // The plaintext key is printed ONCE — never stored after this
    // point. Operators must capture it from stdout and hand it to
    // the resource server via a side channel.
    process.stdout.write(
      [
        `Created resource API key.`,
        ``,
        `  id:    ${created.id}`,
        `  label: ${created.row.label}`,
        `  rate-limit: ${created.row.rateLimitPerMinute}/minute`,
        `  monthly-cap: ${created.row.monthlySettleCap ?? "unlimited"}`,
        ``,
        `Plaintext key (shown ONCE — copy now):`,
        ``,
        `    ${created.plaintext}`,
        ``,
        `The hash is stored; the plaintext is NOT. Lose it and you`,
        `must rotate via revoke + re-create.`,
        ``,
      ].join("\n"),
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
