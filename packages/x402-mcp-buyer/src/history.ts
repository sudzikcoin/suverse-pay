/**
 * Append-only purchase history persisted to a JSONL file in the
 * user's OS state dir. One line per buy_and_call, never rewritten.
 *
 * Location:
 *   $XDG_STATE_HOME/suverse-x402-mcp/history.jsonl
 *   ~/.local/state/suverse-x402-mcp/history.jsonl   (XDG fallback)
 *   $LOCALAPPDATA\suverse-x402-mcp\history.jsonl    (Windows)
 *
 * Why JSONL not JSON: append is O(1) regardless of file size, and a
 * partial write on crash corrupts at most one trailing line — much
 * harder to wedge than a single growing JSON object.
 *
 * Privacy: the file lives entirely on the user's machine. We never
 * send it anywhere. The agent can read its own purchases via the
 * list_recent_purchases tool.
 */

import { mkdir, readFile, appendFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export interface PurchaseRecord {
  /** ISO-8601 UTC. */
  timestamp: string;
  url: string;
  method: string;
  /** Listing id from the catalog, if buy_and_call was given one. */
  listingId: string | null;
  /** CAIP-2. */
  network: string;
  /** Atomic units (string to preserve BigInt precision). */
  amount: string;
  asset: string;
  payer: string;
  payTo: string;
  txHash: string | null;
  /** HTTP status of the upstream after payment. */
  upstreamStatus: number;
}

export function historyPath(env: NodeJS.ProcessEnv = process.env): string {
  const subdir = join("suverse-x402-mcp", "history.jsonl");
  if (platform() === "win32") {
    const base = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(base, subdir);
  }
  const xdgState = env.XDG_STATE_HOME;
  if (xdgState && xdgState.length > 0) return join(xdgState, subdir);
  return join(homedir(), ".local", "state", subdir);
}

export async function appendPurchase(
  record: PurchaseRecord,
  path: string = historyPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + "\n", { encoding: "utf8" });
}

/**
 * Read the last `limit` records, newest first. Returns [] if the
 * file doesn't exist yet (no purchases ever made).
 */
export async function readRecentPurchases(
  limit = 50,
  path: string = historyPath(),
): Promise<PurchaseRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if (isNoEnt(e)) return [];
    throw e;
  }
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const sliced = lines.slice(-limit).reverse();
  const out: PurchaseRecord[] = [];
  for (const line of sliced) {
    try {
      out.push(JSON.parse(line) as PurchaseRecord);
    } catch {
      // Skip corrupted line — keep going. We never rewrite the
      // file, so a partial line is the only realistic corruption.
    }
  }
  return out;
}

function isNoEnt(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: unknown }).code === "ENOENT"
  );
}
