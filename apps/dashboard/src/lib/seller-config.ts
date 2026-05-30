/**
 * Resource server "seller config" — the CRUD + validation layer
 * behind /api/keys/[id]/config and the configure UI.
 *
 * The schema lives in db/migrations/006_seller_configs.sql. This
 * module owns:
 *   - per-namespace payTo address validation (no regex in the DB)
 *   - BigInt-safe price range checks
 *   - cross-tenant ownership lookup
 *   - upsert + read query
 *
 * Every public function here goes through `dbQuery` for parity with
 * the rest of apps/dashboard.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dbQuery } from "./db";
import {
  SUPPORTED_CAIP2_IDS,
  selectionNamespaces,
  type NamespaceFamily,
} from "./networks-catalog";

// ---------------------------------------------------------------
// Per-namespace payTo validators
//
// Kept here (not in the DB) so the UI gets the same error messages
// the API does, and so a future namespace can be plugged in by adding
// one row. Validators are STRING-ONLY checks (regex + bounds) — not
// chain-side liveness probes.
// ---------------------------------------------------------------

interface AddressValidator {
  readonly label: string;
  /** Returns null on success or an error message on failure. */
  validate(addr: string): string | null;
}

const VALIDATORS: Record<NamespaceFamily, AddressValidator> = {
  evm: {
    label: "EVM (Base, Polygon, Arbitrum, …)",
    validate: (addr) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
        return "EVM address must be 0x followed by 40 hex characters";
      }
      return null;
    },
  },
  solana: {
    label: "Solana",
    // base58 alphabet excludes 0, O, I, l. Solana addresses are 32
    // bytes → 32..44 base58 chars; in practice they are 32 or 44.
    validate: (addr) => {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) {
        return "Solana address must be 32-44 base58 chars (no 0, O, I, l)";
      }
      return null;
    },
  },
  cosmos: {
    // Noble bech32: `noble1` + 38 chars of bech32 charset
    // (qpzry9x8gf2tvdw0s3jn54khce6mua7l). Total length 44.
    label: "Cosmos · Noble",
    validate: (addr) => {
      if (!/^noble1[02-9ac-hj-np-z]{38}$/.test(addr)) {
        return "Cosmos Noble address must begin with 'noble1' and be 44 bech32 chars";
      }
      return null;
    },
  },
  tron: {
    // Base58check, 34 chars total, first char is always 'T'.
    label: "TRON",
    validate: (addr) => {
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) {
        return "TRON address must begin with 'T' and be 34 base58 chars";
      }
      return null;
    },
  },
};

export function validatePayToFor(
  namespace: NamespaceFamily,
  addr: string,
): string | null {
  return VALIDATORS[namespace].validate(addr);
}

export function payToLabel(namespace: NamespaceFamily): string {
  return VALIDATORS[namespace].label;
}

// ---------------------------------------------------------------
// Zod schema for the PUT /api/keys/[id]/config body
// ---------------------------------------------------------------

/**
 * Price is sent as a base-10 string. We could let Zod coerce to
 * bigint but JSON serialisation of bigints requires manual handling
 * everywhere; staying string-on-the-wire is simpler.
 */
const PriceAtomicSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/, "price must be a positive integer (atomic units)")
  .refine((s) => {
    try {
      const n = BigInt(s);
      return n >= 1000n && n <= 10_000_000n;
    } catch {
      return false;
    }
  }, "price must be between 1000 and 10000000 atomic units");

/**
 * Strict per-namespace validators for the four payTo fields. Each
 * field is optional in the schema; cross-field consistency (i.e.
 * "if any eip155:* network is selected then payToEvm must be set
 * AND valid") is enforced by `validateConfig` below since Zod
 * cross-field refinements get unwieldy fast.
 */
export const ConfigInputSchema = z.object({
  defaultPriceAtomic: PriceAtomicSchema,
  acceptedNetworks: z
    .array(z.string())
    .max(30, "at most 30 networks per config")
    .default([])
    .refine(
      (arr) => arr.every((c) => SUPPORTED_CAIP2_IDS.has(c)),
      "unknown network id (see /facilitator/supported)",
    ),
  payToEvm: z.string().nullable().optional(),
  payToSolana: z.string().nullable().optional(),
  payToCosmos: z.string().nullable().optional(),
  payToTron: z.string().nullable().optional(),
  description: z
    .string()
    .max(500, "description must be 500 characters or fewer")
    .nullable()
    .optional(),
});

export type ConfigInput = z.infer<typeof ConfigInputSchema>;

/**
 * Cross-field validation. Returns a list of `{ field, message }`
 * pairs. Empty list = OK.
 */
export function validateConfig(
  input: ConfigInput,
): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = [];
  const families = selectionNamespaces(input.acceptedNetworks);

  const requireAddr = (
    family: NamespaceFamily,
    fieldName: string,
    value: string | null | undefined,
  ): void => {
    if (!families.has(family)) return;
    if (value === undefined || value === null || value.trim() === "") {
      errors.push({
        field: fieldName,
        message: `${payToLabel(family)} address is required when a ${family} network is selected`,
      });
      return;
    }
    const reason = validatePayToFor(family, value.trim());
    if (reason !== null) errors.push({ field: fieldName, message: reason });
  };

  requireAddr("evm", "payToEvm", input.payToEvm ?? null);
  requireAddr("solana", "payToSolana", input.payToSolana ?? null);
  requireAddr("cosmos", "payToCosmos", input.payToCosmos ?? null);
  requireAddr("tron", "payToTron", input.payToTron ?? null);

  return errors;
}

// ---------------------------------------------------------------
// DB layer
// ---------------------------------------------------------------

export interface ResourceServerConfig {
  resourceKeyId: string;
  defaultPriceAtomic: string;
  acceptedNetworks: string[];
  payToEvm: string | null;
  payToSolana: string | null;
  payToCosmos: string | null;
  payToTron: string | null;
  description: string | null;
  updatedAt: string;
}

/**
 * Cross-tenant guard. Returns the row from resource_api_keys ⨯
 * dashboard_user_resource_keys (so we know it's active AND linked
 * to the calling user) or null.
 */
export async function findOwnedResourceKey(args: {
  userId: string;
  resourceKeyId: string;
}): Promise<{ id: string; label: string } | null> {
  const rows = await dbQuery<{ id: string; label: string }>(
    `
    SELECT k.id, k.label
    FROM dashboard_user_resource_keys l
    JOIN resource_api_keys k ON k.id = l.resource_key_id
    WHERE l.user_id = $1
      AND k.id = $2
      AND k.is_active
    LIMIT 1
    `,
    [args.userId, args.resourceKeyId],
  );
  return rows[0] ?? null;
}

export async function getConfig(
  resourceKeyId: string,
): Promise<ResourceServerConfig | null> {
  const rows = await dbQuery<{
    resource_key_id: string;
    default_price_atomic: string;
    accepted_networks: string[];
    pay_to_evm: string | null;
    pay_to_solana: string | null;
    pay_to_cosmos: string | null;
    pay_to_tron: string | null;
    description: string | null;
    updated_at: string;
  }>(
    `
    SELECT
      resource_key_id,
      default_price_atomic::text AS default_price_atomic,
      accepted_networks,
      pay_to_evm,
      pay_to_solana,
      pay_to_cosmos,
      pay_to_tron,
      description,
      updated_at::text AS updated_at
    FROM resource_server_configs
    WHERE resource_key_id = $1
    `,
    [resourceKeyId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    resourceKeyId: row.resource_key_id,
    defaultPriceAtomic: row.default_price_atomic,
    acceptedNetworks: row.accepted_networks,
    payToEvm: row.pay_to_evm,
    payToSolana: row.pay_to_solana,
    payToCosmos: row.pay_to_cosmos,
    payToTron: row.pay_to_tron,
    description: row.description,
    updatedAt: row.updated_at,
  };
}

/**
 * INSERT … ON CONFLICT … DO UPDATE. Returns the post-write row.
 *
 * The id (UUID) is generated app-side per project convention. On
 * conflict we keep the original id — only the mutable columns
 * change, and `updated_at` bumps to NOW().
 */
export async function upsertConfig(args: {
  resourceKeyId: string;
  input: ConfigInput;
}): Promise<ResourceServerConfig> {
  const id = randomUUID();
  const { input } = args;
  await dbQuery(
    `
    INSERT INTO resource_server_configs (
      id, resource_key_id, default_price_atomic, accepted_networks,
      pay_to_evm, pay_to_solana, pay_to_cosmos, pay_to_tron,
      description, created_at, updated_at
    )
    VALUES ($1, $2, $3::numeric, $4, $5, $6, $7, $8, $9, NOW(), NOW())
    ON CONFLICT (resource_key_id) DO UPDATE SET
      default_price_atomic = EXCLUDED.default_price_atomic,
      accepted_networks    = EXCLUDED.accepted_networks,
      pay_to_evm           = EXCLUDED.pay_to_evm,
      pay_to_solana        = EXCLUDED.pay_to_solana,
      pay_to_cosmos        = EXCLUDED.pay_to_cosmos,
      pay_to_tron          = EXCLUDED.pay_to_tron,
      description          = EXCLUDED.description,
      updated_at           = NOW()
    `,
    [
      id,
      args.resourceKeyId,
      input.defaultPriceAtomic,
      input.acceptedNetworks,
      input.payToEvm ?? null,
      input.payToSolana ?? null,
      input.payToCosmos ?? null,
      input.payToTron ?? null,
      input.description ?? null,
    ],
  );
  const after = await getConfig(args.resourceKeyId);
  if (!after) {
    // Should be impossible — we just inserted the row.
    throw new Error("seller-config: upsert succeeded but read returned null");
  }
  return after;
}
