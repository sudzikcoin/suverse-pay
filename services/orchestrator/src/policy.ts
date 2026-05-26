import {
  DEFAULT_MERCHANT_POLICY,
  MerchantPolicySchema,
  type MerchantPolicy,
  type MerchantPolicyInput,
} from "@suverse-pay/core-types";

/**
 * Resolves the effective `MerchantPolicy` for a given request from up
 * to three sources, in increasing precedence:
 *
 *   1. The schema default (DEFAULT_MERCHANT_POLICY).
 *   2. The per-API-key policy stored in `merchant_policies`.
 *   3. The per-request policy supplied in the API call body.
 *
 * Pure logic — caller fetches the per-API-key row from DB and passes
 * it in. Undefined sources are skipped. The merged object is parsed
 * back through the Zod schema so we get default-application for any
 * fields the merchant didn't explicitly set, plus runtime validation
 * of weirdly-shaped per-request input.
 */
export function resolvePolicy(input: {
  apiKeyPolicy?: MerchantPolicyInput | null;
  requestPolicy?: MerchantPolicyInput | null;
}): MerchantPolicy {
  const merged: Record<string, unknown> = { ...DEFAULT_MERCHANT_POLICY };
  for (const layer of [input.apiKeyPolicy, input.requestPolicy]) {
    if (layer === undefined || layer === null) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) merged[k] = v;
    }
  }
  return MerchantPolicySchema.parse(merged);
}
