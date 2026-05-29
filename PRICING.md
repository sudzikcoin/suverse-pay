# Pricing — Suverse Pay platform fee

Suverse Pay's revenue model is a flat per-settle fee, expressed in
basis points (bps) on the gross settle amount.

## Default rate

**30 bps (= 0.3%)** of the gross USDC amount per settled
`/facilitator/settle` call. Overridable globally via the
`PLATFORM_FEE_BPS` environment variable (range 0..1000 = 0%..10%)
and per-key via `resource_api_keys.fee_bps`.

## Formula

```
fee_atomic   = floor(gross_atomic * fee_bps / 10_000)
fee_atomic   = clamp(fee_atomic, MIN_FEE_ATOMIC, MAX_FEE_USDC_ATOMIC)
net_atomic   = gross_atomic - fee_atomic
```

Constants (apply when USDC is the asset; future per-chain decimals
will adjust the floor/cap):

| Constant               | Atomic value      | USD equivalent |
| ---------------------- | ----------------- | -------------- |
| `MIN_FEE_ATOMIC`       | `1`               | `$0.000001`    |
| `MAX_FEE_USDC_ATOMIC`  | `1_000_000`       | `$1.00`        |

Floor stops micro-settles from rounding to a fee of zero; cap
protects merchants against a runaway charge on a single large
settle.

## Worked examples (USDC, 6 decimals)

| Gross    | Rate (bps) | Fee       | Net      | Notes                |
| -------- | ---------- | --------- | -------- | -------------------- |
| $1.00    | 30         | $0.003    | $0.997   | typical              |
| $0.01    | 30         | $0.000001 | $0.009999| floor kicks in       |
| $10000   | 30         | $1.00     | $9999    | cap kicks in         |
| $1.00    | 0          | $0.00     | $1.00    | fee disabled per-key |
| $0.000001| 30         | $0.00     | $0.000001| nothing to split     |

## Collection

**On-chain collection is NOT implemented in v1.** The downstream
facilitator (Coinbase CDP / PayAI / Thirdweb / …) still settles the
full gross to the merchant's `paymentRequirements.payTo` address —
suverse-pay has no authority to rewrite either field (the buyer
signed over the exact amount and recipient).

The fee is recorded in `facilitator_payments.fee_amount` as an
accounting overlay. Customers reconcile and pay manually:

1. At the start of each month the customer opens the dashboard at
   `https://suverse-pay.suverse.io/dashboard`.
2. Clicks **Download {previous month} (.csv)** in the "Platform fee
   invoice" panel.
3. CSV ships with a comment-block header listing the period and the
   total amount owed.
4. Customer sends the total in USDC to the operator's payout
   address (or pays via wire / Stripe invoice — operator's choice).

This is intentionally low-friction for the v1 rollout: real revenue
without weeks of work on splitter-contract deployment + custody
policy. On-chain collection is a separate sub-task (3.5) — three
candidate mechanisms are documented in
[`docs/design/per-settle-fee-collection.md`](docs/design/per-settle-fee-collection.md)
(to be written when the customer base + volume justify the work).

## Per-key override

Set a custom rate for a specific key:

```sql
UPDATE resource_api_keys
   SET fee_bps = 50          -- 0.5% just for this key
 WHERE id = 'reskey_xxxxxxxx';
```

NULL means "use `PLATFORM_FEE_BPS` from env at settle time" (the
default).

## Why basis points

- Industry-standard wording (Stripe, traditional payment rails,
  on-chain DEX fees all use bps) — customers translate "30 bps"
  immediately.
- Integer arithmetic — no IEEE 754 surprises on a fee field.
- `INTEGER CHECK (fee_bps BETWEEN 0 AND 1000)` is a tight,
  unambiguous Postgres constraint.

## When the fee is zero

Set `PLATFORM_FEE_BPS=0` globally, or `fee_bps=0` per-key, to
disable the fee entirely. This is the backwards-compatible path for
the period before fee collection went live, and the path you'd take
to honour a free-tier promise for a specific customer.

## Currency note

All values above assume USDC (6-decimal asset on every chain we
currently route). BNB Chain advertises 18-decimal USDC/USDT, which
the v1 fee constants do NOT yet adjust for — a settle on BNB Chain
will hit the cap immediately because `MAX_FEE_USDC_ATOMIC = 1e6` is
$1 in 6-decimal terms but `$0.000000000001` in 18-decimal terms. A
follow-up will introduce per-(asset, chain) decimals into the fee
calculation. Until then, set `fee_bps=0` on keys whose primary
traffic is BNB Chain to avoid surprise capping.
