/**
 * Live smoke tests against the public Suverse Pay facilitator.
 *
 * These DO hit the network — they probe
 * `https://facilitator.suverse.io/facilitator/supported` for
 * reachability and send a `POST /facilitator/verify` with an
 * EVM-signed payload so we catch wire-format regressions before they
 * hurt a real seller.
 *
 * Gated by the `SUVERSE_LIVE` env var so the default unit-test run
 * stays offline + reproducible. To run them once you have network:
 *
 *   SUVERSE_LIVE=1 pnpm --filter @suverselabs/x402-client test \
 *     tests/live-facilitator.test.ts
 *
 * What we expect from a working facilitator:
 *
 *   - `/supported` returns 200 with a `kinds` array advertising at
 *     least `eip155:8453:exact` (Base mainnet — Coinbase CDP).
 *   - `/verify` with an EVM payload signed for Base + a recipient
 *     that does NOT match the seller's real merchant returns 200
 *     with `{ isValid: false, invalidReason: ... }`. The point is
 *     to confirm the wire-format ACCEPTS the payload — we want
 *     `invalidReason` to be a domain-level rejection (e.g.
 *     "insufficient_funds" or "expired_authorization"), NOT a
 *     parsing rejection like "missing field". A parsing rejection
 *     means our client emits a shape the facilitator doesn't
 *     understand, which is the regression we're guarding against.
 *
 * Time-out budget per test: 15 seconds.
 */

import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { EvmSigner } from "../src/signers/evm.js";
import type { AcceptedRequirement } from "../src/types.js";

const FACILITATOR = "https://facilitator.suverse.io";
const LIVE = process.env["SUVERSE_LIVE"] === "1";

const itLive = LIVE ? it : it.skip;

describe(
  `live facilitator smoke (SUVERSE_LIVE=${LIVE ? "1" : "0"})`,
  () => {
    itLive(
      "/facilitator/supported advertises eip155:8453:exact",
      async () => {
        const res = await fetch(`${FACILITATOR}/facilitator/supported`, {
          signal: AbortSignal.timeout(15_000),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          kinds: Array<{ scheme: string; network: string }>;
        };
        expect(Array.isArray(body.kinds)).toBe(true);
        const matches = body.kinds.filter(
          (k) => k.network === "eip155:8453" && k.scheme === "exact",
        );
        expect(matches.length).toBeGreaterThan(0);
      },
      20_000,
    );

    itLive(
      "/facilitator/verify accepts our EVM wire format (rejection MUST be domain-level, not parse-level)",
      async () => {
        const signer = new EvmSigner({ wallet: generatePrivateKey() });
        const requirement: AcceptedRequirement = {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x000000000000000000000000000000000000dEaD",
          amount: "1000", // tiny, throwaway
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        };
        const envelope = await signer.sign({ requirement });

        // The facilitator's /verify expects the v1-flat paymentRequirements
        // shape (maxAmountRequired, not amount). This is the same translation
        // @suverselabs/x402-server-node's middleware does inside callFacilitator
        // before forwarding to the facilitator. The buyer SDK emits v2, the
        // facilitator validates v1 — middleware bridges. To exercise /verify
        // directly without a middleware, we replicate the translation here.
        const paymentRequirementsV1Flat = {
          scheme: requirement.scheme,
          network: requirement.network,
          asset: requirement.asset,
          payTo: requirement.payTo,
          maxAmountRequired: requirement.amount,
          resource: "https://test.example/live-smoke",
          description: "live-smoke",
          mimeType: "application/json",
          maxTimeoutSeconds: requirement.maxTimeoutSeconds,
          extra: requirement.extra ?? {},
        };

        const res = await fetch(`${FACILITATOR}/facilitator/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paymentPayload: envelope,
            paymentRequirements: paymentRequirementsV1Flat,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        // What we care about here is NOT the HTTP status itself —
        // it's whether the facilitator (and its downstream adapter,
        // typically Coinbase CDP for Base) parsed our payload and
        // tried to act on it. Expected outcomes:
        //
        //   - 200 + { isValid: false, invalidReason } — facilitator
        //     ran verify cleanly, CDP recovered the payer, domain
        //     rejection (no funds, no allowance, etc.). This is the
        //     happy path.
        //   - 502 wrapping a CDP 400 with `invalidReason: "invalid_payload"`
        //     + `invalidMessage: "execution reverted"` — facilitator
        //     forwarded to CDP, CDP recovered the payer, the on-chain
        //     `transferWithAuthorization` simulation reverted (because
        //     the throwaway wallet has no USDC). The recovered `payer`
        //     field in the response body proves CDP read our typed-data
        //     correctly.
        //   - 400 / 422 with "missing field" / "invalid_shape" /
        //     "malformed" — wire-format regression. THIS is what we
        //     want to guard against; fail loudly.
        const rawBody = await res.text();
        // 4xx-other (schema) is a regression we want to surface.
        if (res.status >= 400 && res.status < 500) {
          throw new Error(
            `facilitator rejected our envelope with HTTP ${res.status}; body=${rawBody}. This likely means the v2→v1 translation here got out of sync with what middleware does. Wire-format regression.`,
          );
        }
        // Parse what we got.
        let body: unknown;
        try {
          body = JSON.parse(rawBody);
        } catch {
          throw new Error(`facilitator returned non-JSON body: ${rawBody}`);
        }
        // Search for any parse-level signal anywhere in the body.
        const stringified = JSON.stringify(body).toLowerCase();
        const parseLevelSignals = [
          "missing field",
          "required field",
          "invalid_shape",
          "malformed",
          "schema validation",
          "missing required",
        ];
        for (const sig of parseLevelSignals) {
          expect(stringified).not.toContain(sig);
        }
        // Probe whether downstream adapter saw our envelope. CDP's
        // path surfaces `payer` even on rejection.
        expect(stringified).toMatch(/payer|valid|reason/i);
      },
      30_000,
    );
  },
);
