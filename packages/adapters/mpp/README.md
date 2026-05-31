# @suverse-pay/adapter-mpp

Adapter for the **Machine Payments Protocol (MPP)** — a 402-protocol
payment standard launched by Stripe + Tempo in March 2026 and
extended at Stripe Sessions 2026 (April–May 2026). One adapter,
multiple methods; the adapter dispatches by `(method, intent,
network)` tuple at verify/settle time.

Shipped Phase 4 Block 2 Sub-task 9 as `mpp-stripe` /
`StripeMppAdapter`. Renamed in Phase 5 Phase 2 T1+T2 to the generic
`mpp` / `MppAdapter` shape — one adapter, multiple methods (tempo
now, stripe later when REST opens).

## What MPP actually is

MPP is a sibling protocol to x402. Both use HTTP 402 challenges +
client-signed retries. The differences:

| Aspect | x402 | MPP |
|---|---|---|
| Challenge wire | Response body + `X-PAYMENT` header | One or more `WWW-Authenticate: Payment ...` headers |
| Credential wire | `X-PAYMENT` header on retry | `Authorization: Payment <token>` header on retry |
| Methods | One scheme per request (`exact`, etc.) | Matrix of `(method, intent)` pairs — `tempo charge`, `stripe charge`, `solana charge`, `lightning subscription`, etc. |
| Intents | Effectively one — "pay this amount now" | `charge` (one-shot), `subscription` (recurring), `session` (pay-as-you-go) |
| Settlement chains | Wide multi-chain (16+ EVM, Solana, TRON, Cosmos) | Tempo L1 as canonical (USDC, EIP-155 chain 4217); plus Stripe fiat (SPT), Lightning, Solana, Monad, Stellar, RedotPay |

> **Important corrective**: an earlier internal sketch described MPP
> as a "session pre-authorization protocol" with open/use/close
> lifecycle. That's a misreading. MPP's `intent` field has three
> values — `charge`, `subscription`, `session` — but each individual
> 402 challenge is single-shot, the same shape x402 uses. The
> "session" intent is for pay-as-you-go billing (think token-stream
> meters), not user-facing wallet authorization flows. Phase 5 wires
> subscription + session intents once Stripe publishes the REST
> surface for them.

## What this adapter ships in Phase 4

| Surface | Status |
|---|---|
| `MppFacilitatorAdapter` interface (new, alongside x402's `ProviderAdapter`) | ✓ (renamed from `MppAdapter` in Phase 5 Phase 2 T2) |
| `MppAdapter` implementation | ✓ — health check + capability advertising (renamed from `StripeMppAdapter` in Phase 5 Phase 2 T2) |
| Tempo USDC entry in `signer-evm/domains.ts` (`eip155:4217`) | ✓ — Tempo is EVM-compatible, slots into the existing namespace |
| Wire-format primitives — `challengeToHeaderLine` / `credentialFromHeaderLine` etc. | ✓ — RFC-7235-flavored, base64url JSON |
| Types: `MppChallenge`, `MppCredential`, `MppCapability` (mirrors wevm/mppx's `Challenge.Schema`) | ✓ |
| Stripe MPP `verifyCredential` / `settleCredential` REST paths | ✗ Stripe has not published the REST endpoints publicly. Adapter returns a structured "endpoint not yet wired" error rather than silently passing. |
| `/mpp/*` HTTP front door in `apps/api` | ✗ Phase 5 — needs the Stripe REST paths to wire against |
| Persisted MPP sessions in Postgres | ✗ Phase 5 — only relevant once `intent=session` semantics stabilize |
| Real on-chain Tempo smoke | ✗ Phase 5 — needs `STRIPE_MPP_SECRET_KEY` (merchant onboarding required) |

The adapter is internally callable today — application code that
speaks MPP can pull `MppAdapter` from this package and use the
wire-translation primitives + capability advertising. First-party
gateway-side `/mpp/*` routes land in Phase 5 Phase 2 T8 (Tempo
Moderato testnet via direct JSON-RPC) and stay deferred for mainnet
until Stripe publishes the REST surface.

## Tempo network

Tempo is the canonical MPP settlement chain — a payments-focused L1
that went mainnet 2026-03-18. EVM-compatible, EIP-155.

| Property | Value |
|---|---|
| Mainnet chainId | 4217 (0x1079) → CAIP-2 `eip155:4217` |
| Moderato testnet chainId | 42431 (0xa5bf) → `eip155:42431` |
| Mainnet RPC | `https://rpc.tempo.xyz` |
| Moderato RPC | `https://rpc.moderato.tempo.xyz` |
| Block explorer | `https://explore.tempo.xyz` |
| Native gas token | **None** — fees paid in any whitelisted USD stablecoin |
| Finality | sub-second (Simplex BFT consensus) |
| USDC (mainnet) | `0x20C0…E8b50` — "Bridged USDC (Stargate)", symbol `USDC.e`, 6 decimals |

The USDC contract was verified on-chain via `eth_call` 2026-05-29.
`version()` reverts — Tempo's USDC is NOT a canonical Circle EIP-3009
deployment. EIP-3009 sigs produced against this entry fail at
on-chain verification; the MPP path (or Permit2 via Sub-task 6 if
the proxy is deployed on Tempo) is the route.

## Wire format primitives

```ts
import {
  challengeToHeaderLine,
  challengeFromHeaderLine,
  credentialToHeaderLine,
  credentialFromHeaderLine,
} from "@suverse-pay/adapter-mpp";

// Server side — emit a 402.
const headerValue = challengeToHeaderLine({
  id: "chal_abc",
  realm: "api.example.com",
  method: "tempo",
  intent: "charge",
  request: { amount: "1000000", currency: "USDC", recipient: "0xRecipient..." },
});
// → `Payment id="chal_abc", realm="api.example.com", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxMDAwMDAwIiwi..."`

// Client side — parse a 402.
const challenge = challengeFromHeaderLine(wwwAuthenticateHeader);

// Client side — emit Authorization: Payment.
const authValue = credentialToHeaderLine({
  challengeId: "chal_abc",
  method: "tempo",
  intent: "charge",
  payload: { type: "transaction", signature: "0x..." },
});

// Server side — parse Authorization: Payment.
const credential = credentialFromHeaderLine(authorizationHeader);
```

All MPP-spec-defined fields are surfaced; `request` payloads are
arbitrary `Record<string, unknown>` so method-specific shapes (e.g.
`tempo charge`'s `{amount, currency, recipient}` from
`wevm/mppx`'s `Methods.ts`) flow through verbatim.

## Authentication

`STRIPE_MPP_SECRET_KEY` — Stripe's standard `sk_live_...` /
`sk_test_...` bearer key. Absent, the adapter still:

- Registers + appears on the observability dashboard
- Advertises capabilities (`getCapabilities()` works)
- Reports `getHealthStatus()` (cheap HEAD against `api.stripe.com`)

…but `verifyCredential` / `settleCredential` throw
`ProviderError("unauthorized")` with a clear message. This mirrors
the Binance adapter pattern from Sub-task 7.

## Sources

- [Stripe + Tempo: Introducing the Machine Payments Protocol](https://stripe.com/blog/machine-payments-protocol)
- [Stripe Sessions 2026 announcements](https://stripe.com/blog/everything-we-announced-at-sessions-2026)
- [Stripe MPP docs](https://docs.stripe.com/payments/machine/mpp)
- [mpp.dev — protocol specification site](https://mpp.dev)
- [`wevm/mppx` — canonical TypeScript SDK](https://github.com/wevm/mppx)
- [`tempoxyz/tempo-ts` — Tempo TypeScript tooling](https://github.com/tempoxyz/tempo-ts)
- [Tempo connection details](https://docs.tempo.xyz/quickstart/connection-details)
