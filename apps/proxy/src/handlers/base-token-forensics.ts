/**
 * Base Token Forensics — ONE aggregated $0.35 verdict answering "is
 * this Base (eip155:8453) token contract safe to touch?". Buyer POSTs
 * { contract_address } and gets a merged forensic dossier plus a
 * single CLEAN / WATCH / RED_FLAG verdict.
 *
 * Demand context: a bot probed our three per-piece Base endpoints
 * 12,744 times unpaid — this product bundles them into one call.
 *
 * Sources — the three existing internal handlers, reused IN-PROCESS
 * (their fetches flow through the same `fetchImpl`, so tests stub the
 * UPSTREAM urls, not the handlers):
 *
 *   1. etherscan_base_contract_info  (CRITICAL) — verification status,
 *      name, proxy-ness. The preflight proves it BEFORE settlement; if
 *      it is down the buyer gets a 503 and is NOT charged.
 *   2. blockscout_base_token_holders (non-critical) — top-holder
 *      concentration. Failure degrades: the verdict is computed
 *      without concentration and the gap is disclosed in
 *      data_quality.stale_sources (+ a `concentration_unknown` flag).
 *   3. base_rpc_tx_decoder           (non-critical) — recent activity.
 *      We list recent token transfers from Blockscout REST, then
 *      decode up to 2 of the most recent tx hashes. Entirely
 *      best-effort inside a 10s sequential budget.
 *
 * Deployer + contract age come from Blockscout's address / creation-tx
 * endpoints (same non-critical budget); when unobtainable they are
 * null and the age-based rules simply don't fire.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerPreflight,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";
import {
  isPlaceholderValue,
  type InternalHandlerInputSchema,
} from "./discovery.js";
import { etherscanBaseContractInfo } from "./etherscan-base-contract-info.js";
import { blockscoutBaseTokenHolders } from "./blockscout-base-token-holders.js";
import { baseRpcTxDecoder } from "./base-rpc-tx-decoder.js";

// ─────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

// Mirrors the base URL blockscout-base-token-holders.ts calls.
const BLOCKSCOUT_API = "https://base.blockscout.com/api/v2";

// The holders sibling allows itself 25s (Blockscout cold-cache P99);
// we race it against our own cap so a stuck upstream degrades the
// concentration axis instead of stalling the whole dossier.
const HOLDERS_BUDGET_MS = 12_000;

// Total budget for ALL non-critical enrichment beyond holders
// (transfer list + up to 2 tx decodes + deployer/age lookups),
// spent sequentially; each individual call is further capped.
const ACTIVITY_BUDGET_MS = 10_000;
const PER_CALL_CAP_MS = 4_000;

const MAX_DECODED_TXS = 2;
const MAX_TOP_HOLDERS = 10;

// Verdict thresholds — see deriveForensicsVerdict for the rule table.
const RED_TOP10_UNVERIFIED_PCT = 70;
const RED_TOP1_PCT = 50;
const WATCH_TOP10_PCT = 50;
const NEW_CONTRACT_MAX_AGE_DAYS = 7;
const LOW_HOLDER_COUNT = 50;

// raw.* size caps (bytes of JSON) — total ≈ 6 KiB.
const RAW_CONTRACT_INFO_CAP = 2_048;
const RAW_HOLDERS_PAGE_CAP = 2_560;
const RAW_DECODED_TXS_CAP = 1_536;

// ─────────────────────────────────────────────────────────────────────
// Input classification (discovery split, hex-address flavor)
// ─────────────────────────────────────────────────────────────────────

type ContractFieldClassification =
  /** No body / no usable field / placeholder — serve the 402 challenge. */
  | { kind: "discovery" }
  | { kind: "invalid_json" }
  | { kind: "malformed" }
  | { kind: "invalid_value"; value: string }
  | { kind: "valid"; value: string };

function classifyContractField(
  body: Buffer | null,
): ContractFieldClassification {
  if (!body || body.length === 0 || body.toString("utf8").trim() === "") {
    return { kind: "discovery" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { kind: "invalid_json" };
  }
  if (parsed === null) return { kind: "discovery" };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed" };
  }
  const value = (parsed as Record<string, unknown>)["contract_address"];
  if (typeof value !== "string") return { kind: "discovery" };
  if (isPlaceholderValue(value)) return { kind: "discovery" };
  if (!EVM_ADDRESS_RE.test(value)) return { kind: "invalid_value", value };
  return { kind: "valid", value: value.toLowerCase() };
}

function parseContract(body: Buffer | null): string | null {
  const c = classifyContractField(body);
  return c.kind === "valid" ? c.value : null;
}

/**
 * Machine-readable input contract merged into the 402 challenge body
 * (top-level `input_schema`) so catalog crawlers and schema-aware
 * agents learn the request shape from the challenge.
 */
export const baseTokenForensicsInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: ["contract_address"],
    properties: {
      contract_address: {
        type: "string",
        description:
          "Base (eip155:8453) token contract address to investigate (0x + 40 hex chars)",
        pattern: EVM_ADDRESS_RE.source,
      },
    },
  },
  example: { contract_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
};

/**
 * Pre-payment validator with the discovery split (see discovery.ts):
 * empty / missing / placeholder `contract_address` passes through
 * (null) so unpaid probes reach the 402 challenge; a PAID request with
 * such a body is still stopped pre-settlement by the preflight. Only a
 * PRESENT non-placeholder string failing the hex-address pattern gets
 * the 422 before the challenge; invalid JSON stays a 400.
 */
export const baseTokenForensicsValidator: InternalHandlerValidator = (
  body,
  _method,
) => {
  const c = classifyContractField(body);
  switch (c.kind) {
    case "discovery":
    case "valid":
      return null;
    case "invalid_json":
      return { status: 400, body: { error: "invalid_json_body" } };
    case "malformed":
      return {
        status: 422,
        body: {
          error: "contract_address_required",
          expected: '{"contract_address":"<0x base token contract>"}',
        },
      };
    case "invalid_value":
      return {
        status: 422,
        body: {
          error: "invalid_contract_address",
          detail:
            "contract_address must be a Base (eip155:8453) address: 0x followed by 40 hex chars",
          input_schema: baseTokenForensicsInputSchema,
        },
      };
  }
};

// ─────────────────────────────────────────────────────────────────────
// Pure derived metrics — exported for unit tests.
// ─────────────────────────────────────────────────────────────────────

export interface HolderShareRow {
  address?: string | null;
  percentOfSupply?: number | null;
}

export interface Concentration {
  top1_share_pct: number | null;
  top10_share_pct: number | null;
  top_holders: Array<{ address: string | null; share_pct: number | null }>;
}

/**
 * Concentration from the Blockscout top-holders page (≤50 rows,
 * already sorted descending by the sibling handler). Shares are the
 * page's percentOfSupply values; rows lacking a numeric share
 * contribute 0 to top-10 but keep their slot in top_holders. When NO
 * row carries a numeric share (missing total supply), both shares are
 * null → concentration is UNKNOWN, not zero.
 */
export function computeConcentration(holders: HolderShareRow[]): Concentration {
  const top = holders.slice(0, MAX_TOP_HOLDERS).map((h) => ({
    address: typeof h.address === "string" ? h.address : null,
    share_pct:
      typeof h.percentOfSupply === "number" && Number.isFinite(h.percentOfSupply)
        ? round2(h.percentOfSupply)
        : null,
  }));
  const known = top.filter((h) => h.share_pct !== null);
  if (known.length === 0) {
    return { top1_share_pct: null, top10_share_pct: null, top_holders: top };
  }
  const first = top[0];
  return {
    top1_share_pct: first ? first.share_pct : null,
    top10_share_pct: round2(
      top.reduce((acc, h) => acc + (h.share_pct ?? 0), 0),
    ),
    top_holders: top,
  };
}

export type ForensicsStatus = "CLEAN" | "WATCH" | "RED_FLAG";

export interface ForensicFacts {
  is_verified: boolean;
  /** null = unknown (holders source degraded or supply missing). */
  top1_share_pct: number | null;
  top10_share_pct: number | null;
  holder_count: number | null;
  /** null = unknown (creation tx not obtainable). */
  age_days: number | null;
  /** false when the holders source degraded / shares unknowable. */
  concentration_known: boolean;
}

export interface ForensicsVerdict {
  status: ForensicsStatus;
  flags: string[];
  summary: string;
}

/**
 * Verdict rule table (unknown facts NEVER escalate — a null share or
 * age simply doesn't fire its rule; the concentration_unknown flag is
 * the honesty valve):
 *
 *   RED_FLAG if any of
 *     R1: unverified AND top10_share > 70%
 *     R2: top1_share > 50%
 *     R3: age < 7d AND top10_share > 50%
 *   WATCH if any single flag fires:
 *     unverified_contract | top10_share_gt_50pct | new_contract_lt_7d
 *     | holder_count_lt_50 | concentration_unknown
 *   CLEAN otherwise.
 *
 * A top10 share over 70% emits only the stronger top10_share_gt_70pct
 * flag (gt_50 is implied).
 */
export function deriveForensicsVerdict(facts: ForensicFacts): ForensicsVerdict {
  const flags: string[] = [];
  const {
    is_verified,
    top1_share_pct: top1,
    top10_share_pct: top10,
    holder_count,
    age_days,
    concentration_known,
  } = facts;

  if (!is_verified) flags.push("unverified_contract");
  if (top1 !== null && top1 > RED_TOP1_PCT) flags.push("top1_share_gt_50pct");
  if (top10 !== null && top10 > RED_TOP10_UNVERIFIED_PCT) {
    flags.push("top10_share_gt_70pct");
  } else if (top10 !== null && top10 > WATCH_TOP10_PCT) {
    flags.push("top10_share_gt_50pct");
  }
  if (age_days !== null && age_days < NEW_CONTRACT_MAX_AGE_DAYS) {
    flags.push("new_contract_lt_7d");
  }
  if (holder_count !== null && holder_count < LOW_HOLDER_COUNT) {
    flags.push("holder_count_lt_50");
  }
  if (!concentration_known) flags.push("concentration_unknown");

  const redReasons: string[] = [];
  if (!is_verified && top10 !== null && top10 > RED_TOP10_UNVERIFIED_PCT) {
    redReasons.push(
      `unverified contract with top-10 holders controlling ${top10.toFixed(1)}% of supply`,
    );
  }
  if (top1 !== null && top1 > RED_TOP1_PCT) {
    redReasons.push(`a single holder controls ${top1.toFixed(1)}% of supply`);
  }
  if (
    age_days !== null &&
    age_days < NEW_CONTRACT_MAX_AGE_DAYS &&
    top10 !== null &&
    top10 > WATCH_TOP10_PCT
  ) {
    redReasons.push(
      `contract is only ${Math.floor(age_days)}d old with top-10 holders at ${top10.toFixed(1)}%`,
    );
  }

  if (redReasons.length > 0) {
    return {
      status: "RED_FLAG",
      flags,
      summary: `RED-FLAG: ${redReasons.join("; ")}.`,
    };
  }
  if (flags.length > 0) {
    const phrases: Record<string, string> = {
      unverified_contract: "source code is not verified",
      top10_share_gt_50pct: `top-10 holders control ${top10?.toFixed(1)}% of supply`,
      top10_share_gt_70pct: `top-10 holders control ${top10?.toFixed(1)}% of supply`,
      new_contract_lt_7d: `contract is under ${NEW_CONTRACT_MAX_AGE_DAYS} days old`,
      holder_count_lt_50: `only ${holder_count} holders`,
      concentration_unknown:
        "holder concentration could not be determined this read",
    };
    return {
      status: "WATCH",
      flags,
      summary: `WATCH: ${flags.map((f) => phrases[f] ?? f).join("; ")}.`,
    };
  }
  return {
    status: "CLEAN",
    flags,
    summary:
      `CLEAN: verified contract with distributed holdings` +
      (top10 !== null ? ` (top-10 hold ${top10.toFixed(1)}% of supply` : "") +
      (top10 !== null && holder_count !== null
        ? ` across ${holder_count} holders)`
        : top10 !== null
          ? ")"
          : "") +
      ` and no red flags.`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Source wrappers (all in-process reuse — same fetchImpl flows through)
// ─────────────────────────────────────────────────────────────────────

interface ContractInfoSlim {
  contract: string;
  verified: boolean;
  name: string | null;
  isProxy: boolean;
  implementationAddress: string | null;
  compilerVersion: string | null;
  licenseType: string | null;
  optimizationUsed: boolean | null;
  sourceAvailable: boolean;
}

type ContractInfoOutcome =
  | { ok: true; info: ContractInfoSlim }
  | { ok: false; status: number; body: unknown };

/**
 * CRITICAL source. Strips the (potentially 64 KiB) source body + ABI
 * immediately — the dossier only needs verification facts, and the
 * slim shape keeps preflightData / raw small.
 */
async function fetchContractInfo(
  input: InternalHandlerInput,
  contract: string,
): Promise<ContractInfoOutcome> {
  let res: InternalHandlerResult;
  try {
    res = await etherscanBaseContractInfo({
      body: Buffer.from(JSON.stringify({ contract_address: contract })),
      method: "POST",
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "critical_source_unavailable",
        source: "contract_info",
        detail: (err as Error).message ?? "unknown",
        retryable: true,
      },
    };
  }
  if (res.status === 404) {
    // The address is not a known contract — honest 404, never settle.
    return { ok: false, status: 404, body: { error: "contract_not_found" } };
  }
  if (res.status !== 200) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "critical_source_unavailable",
        source: "contract_info",
        detail: `contract_info_status_${res.status}`,
        retryable: true,
      },
    };
  }
  const b = res.body as Record<string, unknown>;
  return {
    ok: true,
    info: {
      contract,
      verified: b["verified"] === true,
      name: typeof b["name"] === "string" ? (b["name"] as string) : null,
      isProxy: b["isProxy"] === true,
      implementationAddress:
        typeof b["implementationAddress"] === "string"
          ? (b["implementationAddress"] as string)
          : null,
      compilerVersion:
        typeof b["compilerVersion"] === "string"
          ? (b["compilerVersion"] as string)
          : null,
      licenseType:
        typeof b["licenseType"] === "string" ? (b["licenseType"] as string) : null,
      optimizationUsed:
        typeof b["optimizationUsed"] === "boolean"
          ? (b["optimizationUsed"] as boolean)
          : null,
      sourceAvailable: typeof b["sourceCode"] === "string",
    },
  };
}

interface HoldersPage {
  name: string | null;
  symbol: string | null;
  totalHolders: number | null;
  sampleSize: number;
  holders: HolderShareRow[];
  raw: Record<string, unknown>;
}

type HoldersOutcome =
  | { ok: true; page: HoldersPage }
  | { ok: false; error: string };

/** Non-critical: any failure degrades the concentration axis. */
async function fetchHolders(
  input: InternalHandlerInput,
  contract: string,
): Promise<HoldersOutcome> {
  const promise = blockscoutBaseTokenHolders({
    body: Buffer.from(JSON.stringify({ contract_address: contract })),
    method: "POST",
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  }).catch(
    (err: unknown): InternalHandlerResult => ({
      status: 502,
      body: { error: (err as Error).message ?? "holders_threw" },
    }),
  );
  const res = await raceBudget(promise, HOLDERS_BUDGET_MS);
  if (res === null) return { ok: false, error: "holders_budget_exceeded" };
  if (res.status !== 200) {
    return { ok: false, error: `holders_status_${res.status}` };
  }
  const b = res.body as Record<string, unknown>;
  const holders = Array.isArray(b["holders"])
    ? (b["holders"] as HolderShareRow[])
    : [];
  return {
    ok: true,
    page: {
      name: typeof b["name"] === "string" ? (b["name"] as string) : null,
      symbol: typeof b["symbol"] === "string" ? (b["symbol"] as string) : null,
      totalHolders:
        typeof b["totalHolders"] === "number" ? (b["totalHolders"] as number) : null,
      sampleSize: holders.length,
      holders,
      raw: b,
    },
  };
}

export interface DecodedTxSummary {
  tx_hash: string;
  status: string | null;
  summary: string | null;
  method_id: string | null;
  erc20_transfer_count: number | null;
  block_number: number | null;
}

interface ActivityOutcome {
  ok: boolean;
  error: string | null;
  decoded: DecodedTxSummary[];
  rawDecoded: unknown[];
}

/**
 * Non-critical: list recent token transfers from Blockscout REST, then
 * decode up to 2 distinct tx hashes via the base_rpc_tx_decoder
 * sibling — sequentially, each call bounded by the shared budget.
 */
async function fetchRecentActivity(
  input: InternalHandlerInput,
  contract: string,
  budget: Budget,
): Promise<ActivityOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const list = await fetchJsonWithin(
    fetchImpl,
    `${BLOCKSCOUT_API}/tokens/${contract}/transfers`,
    budget,
  );
  if (!list.ok) {
    return { ok: false, error: `transfers_${list.error}`, decoded: [], rawDecoded: [] };
  }
  const itemsRaw = (list.data as Record<string, unknown> | null)?.["items"];
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];
  const hashes: string[] = [];
  for (const it of items) {
    if (typeof it !== "object" || it === null) continue;
    const rec = it as Record<string, unknown>;
    // Blockscout has shipped both spellings across versions.
    const h = rec["tx_hash"] ?? rec["transaction_hash"];
    if (typeof h === "string" && TX_HASH_RE.test(h) && !hashes.includes(h)) {
      hashes.push(h);
    }
    if (hashes.length >= MAX_DECODED_TXS) break;
  }
  const decoded: DecodedTxSummary[] = [];
  const rawDecoded: unknown[] = [];
  for (const h of hashes) {
    const remaining = budget.remaining();
    if (remaining <= 0) break;
    const promise = baseRpcTxDecoder({
      body: Buffer.from(JSON.stringify({ tx_hash: h })),
      method: "POST",
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    }).catch(
      (): InternalHandlerResult => ({ status: 502, body: { error: "decoder_threw" } }),
    );
    const res = await raceBudget(promise, remaining);
    if (res === null || res.status !== 200) continue;
    const b = res.body as Record<string, unknown>;
    decoded.push({
      tx_hash: typeof b["hash"] === "string" ? (b["hash"] as string) : h,
      status: typeof b["status"] === "string" ? (b["status"] as string) : null,
      summary: typeof b["summary"] === "string" ? (b["summary"] as string) : null,
      method_id:
        typeof b["methodId"] === "string" ? (b["methodId"] as string) : null,
      erc20_transfer_count:
        typeof b["transferCount"] === "number"
          ? (b["transferCount"] as number)
          : null,
      block_number:
        typeof b["blockNumber"] === "number" ? (b["blockNumber"] as number) : null,
    });
    rawDecoded.push(sanitizeDecodedRaw(b));
  }
  return { ok: true, error: null, decoded, rawDecoded };
}

/**
 * Best-effort deployer + creation timestamp via Blockscout address +
 * transaction endpoints. Failure yields nulls — the age rules simply
 * don't fire; this is not tracked as a distinct degraded source.
 */
async function fetchDeployerInfo(
  fetchImpl: typeof fetch,
  contract: string,
  budget: Budget,
): Promise<{ deployer: string | null; createdAt: Date | null }> {
  const addr = await fetchJsonWithin(
    fetchImpl,
    `${BLOCKSCOUT_API}/addresses/${contract}`,
    budget,
  );
  if (!addr.ok) return { deployer: null, createdAt: null };
  const rec = (addr.data ?? {}) as Record<string, unknown>;
  const deployer =
    typeof rec["creator_address_hash"] === "string"
      ? (rec["creator_address_hash"] as string)
      : null;
  const creationTx = rec["creation_tx_hash"] ?? rec["creation_transaction_hash"];
  if (typeof creationTx !== "string" || !TX_HASH_RE.test(creationTx)) {
    return { deployer, createdAt: null };
  }
  const tx = await fetchJsonWithin(
    fetchImpl,
    `${BLOCKSCOUT_API}/transactions/${creationTx}`,
    budget,
  );
  if (!tx.ok) return { deployer, createdAt: null };
  const ts = ((tx.data ?? {}) as Record<string, unknown>)["timestamp"];
  if (typeof ts !== "string") return { deployer, createdAt: null };
  const d = new Date(ts);
  return {
    deployer,
    createdAt: Number.isNaN(d.getTime()) ? null : d,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Critical data + preflight (fail-closed gate)
// ─────────────────────────────────────────────────────────────────────

interface CriticalData {
  kind: "base_token_forensics_critical";
  contract: string;
  contractInfo: ContractInfoSlim;
}

function isCriticalData(v: unknown): v is CriticalData {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as CriticalData).kind === "base_token_forensics_critical"
  );
}

/**
 * Fail-closed gate, run by the dispatcher BEFORE the payment settles.
 * Proves the critical contract-info source by actually calling it; on
 * success the result threads into the handler as `preflightData` so
 * Etherscan is hit exactly once per paid call. On failure the buyer
 * gets a 503 (or honest 404) and is NOT charged.
 */
export const baseTokenForensicsPreflight: InternalHandlerPreflight = async (
  input,
) => {
  const contract = parseContract(input.body);
  if (contract === null) {
    // PRIMARY anti-"pay for garbage" gate for discovery-class bodies:
    // the validator deliberately lets empty/placeholder bodies through
    // to the 402 challenge, so a buyer who then PAYS with such a body
    // lands here — 422, never settles.
    return {
      proceed: false,
      status: 422,
      body: {
        error: "invalid_contract_address",
        input_schema: baseTokenForensicsInputSchema,
      },
    };
  }
  const critical = await fetchContractInfo(input, contract);
  if (!critical.ok) {
    return { proceed: false, status: critical.status, body: critical.body };
  }
  return {
    proceed: true,
    data: {
      kind: "base_token_forensics_critical",
      contract,
      contractInfo: critical.info,
    } satisfies CriticalData,
  };
};

// ─────────────────────────────────────────────────────────────────────
// The handler
// ─────────────────────────────────────────────────────────────────────

export const baseTokenForensics: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = baseTokenForensicsValidator(input.body, input.method);
  if (rejected) return rejected;
  const contract = parseContract(input.body);
  if (contract === null) {
    return {
      status: 422,
      body: {
        error: "invalid_contract_address",
        input_schema: baseTokenForensicsInputSchema,
      },
    };
  }

  // Critical source: normally pre-computed by the preflight on this
  // same request. The recompute path covers direct invocation (tests,
  // dev) — if it fails here the buyer HAS paid, so this is a
  // last-resort 503/404, not the primary gate.
  let contractInfo: ContractInfoSlim;
  if (isCriticalData(input.preflightData)) {
    contractInfo = input.preflightData.contractInfo;
  } else {
    const critical = await fetchContractInfo(input, contract);
    if (!critical.ok) return { status: critical.status, body: critical.body };
    contractInfo = critical.info;
  }

  // Non-critical axes — each degrades independently. They run
  // CONCURRENTLY so total added wall-time is max(holders 12s race,
  // activity/deployer 10s budget) ≈ the ~10s product budget, not the
  // ~22s their sequential sum would be — and a slow transfer-decode
  // path can no longer starve the deployer/age lookup (which feeds
  // the age<7d verdict rules; decoded txs are only cosmetic).
  const budget = new Budget(ACTIVITY_BUDGET_MS);
  const [holders, activity, { deployer, createdAt }] = await Promise.all([
    fetchHolders(input, contract),
    fetchRecentActivity(input, contract, budget),
    fetchDeployerInfo(input.fetchImpl ?? fetch, contract, budget),
  ]);

  return {
    status: 200,
    body: buildForensicsResponse({
      contract,
      contractInfo,
      holders,
      activity,
      deployer,
      createdAt,
      computedAt: new Date(),
    }),
  };
};

// ─────────────────────────────────────────────────────────────────────
// Response assembly — pure, exported for tests.
// ─────────────────────────────────────────────────────────────────────

export interface BuildForensicsArgs {
  contract: string;
  contractInfo: {
    contract: string;
    verified: boolean;
    name: string | null;
    isProxy: boolean;
    implementationAddress: string | null;
    compilerVersion: string | null;
    licenseType: string | null;
    optimizationUsed: boolean | null;
    sourceAvailable: boolean;
  };
  holders: { ok: true; page: HoldersPage } | { ok: false; error: string };
  activity: {
    ok: boolean;
    error: string | null;
    decoded: DecodedTxSummary[];
    rawDecoded: unknown[];
  };
  deployer: string | null;
  createdAt: Date | null;
  computedAt: Date;
}

export function buildForensicsResponse(
  args: BuildForensicsArgs,
): Record<string, unknown> {
  const { contract, contractInfo, holders, activity, deployer, createdAt, computedAt } =
    args;

  const concentration: Concentration = holders.ok
    ? computeConcentration(holders.page.holders)
    : { top1_share_pct: null, top10_share_pct: null, top_holders: [] };
  const holderCount = holders.ok
    ? (holders.page.totalHolders ?? holders.page.sampleSize)
    : null;
  const ageDays =
    createdAt !== null
      ? (computedAt.getTime() - createdAt.getTime()) / 86_400_000
      : null;

  const verdictCore = deriveForensicsVerdict({
    is_verified: contractInfo.verified,
    top1_share_pct: concentration.top1_share_pct,
    top10_share_pct: concentration.top10_share_pct,
    holder_count: holderCount,
    age_days: ageDays,
    concentration_known: holders.ok && concentration.top10_share_pct !== null,
  });

  const staleSources: string[] = [];
  if (!holders.ok) staleSources.push("holders");
  if (!activity.ok) staleSources.push("activity");
  const confidence: "high" | "medium" | "low" =
    staleSources.length === 0
      ? "high"
      : staleSources.length === 1
        ? "medium"
        : "low";

  return {
    contract_address: contract,
    verdict: {
      status: verdictCore.status,
      flags: verdictCore.flags,
      summary: verdictCore.summary,
      confidence,
    },
    signals: {
      contract: {
        name: contractInfo.name ?? (holders.ok ? holders.page.name : null),
        symbol: holders.ok ? holders.page.symbol : null,
        is_verified: contractInfo.verified,
        is_proxy: contractInfo.isProxy,
        deployer,
        created_at: createdAt !== null ? createdAt.toISOString() : null,
        age_days: ageDays !== null ? round2(ageDays) : null,
      },
      holders: {
        holder_count: holderCount,
        top1_share_pct: concentration.top1_share_pct,
        top10_share_pct: concentration.top10_share_pct,
        top_holders: concentration.top_holders,
      },
      recent_activity: activity.decoded,
    },
    data_quality: {
      stale_sources: staleSources,
      computed_at: computedAt.toISOString(),
      sources: {
        contract_info: "ok",
        holders: holders.ok ? "ok" : "degraded",
        activity: activity.ok ? "ok" : "degraded",
      },
    },
    raw: {
      contract_info: capSection(contractInfo, RAW_CONTRACT_INFO_CAP),
      holders_page: holders.ok
        ? capSection(
            {
              ...holders.page.raw,
              holders: holders.page.holders.slice(0, MAX_TOP_HOLDERS),
            },
            RAW_HOLDERS_PAGE_CAP,
          )
        : null,
      decoded_txs: capSection(activity.rawDecoded, RAW_DECODED_TXS_CAP),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────────────

class Budget {
  private readonly deadline: number;
  constructor(ms: number) {
    this.deadline = Date.now() + ms;
  }
  remaining(): number {
    return Math.max(0, this.deadline - Date.now());
  }
}

/** Race a never-rejecting promise against the remaining budget. */
async function raceBudget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  if (ms <= 0) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchJsonWithin(
  fetchImpl: typeof fetch,
  url: string,
  budget: Budget,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const ms = Math.min(PER_CALL_CAP_MS, budget.remaining());
  if (ms <= 0) return { ok: false, error: "budget_exhausted" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: `status_${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return {
      ok: false,
      error: (err as { name?: string }).name === "AbortError" ? "timeout" : "unreachable",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Keep decoded-tx raws small: drop calldata, cap transfer list. */
function sanitizeDecodedRaw(b: Record<string, unknown>): Record<string, unknown> {
  const { input: _calldata, erc20Transfers, ...rest } = b as Record<string, unknown> & {
    erc20Transfers?: unknown;
  };
  return {
    ...rest,
    erc20Transfers: Array.isArray(erc20Transfers)
      ? erc20Transfers.slice(0, 5)
      : erc20Transfers ?? null,
  };
}

function capSection(value: unknown, maxBytes: number): unknown {
  try {
    const s = JSON.stringify(value);
    if (s === undefined || s.length <= maxBytes) return value ?? null;
    return { omitted: true, reason: "size_cap", bytes: s.length };
  } catch {
    return { omitted: true, reason: "unserializable" };
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
