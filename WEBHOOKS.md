# Webhooks — Suverse Pay

Push settle-lifecycle events to your own URL, signed with
HMAC-SHA256. v1 ships two event types and an at-least-once delivery
guarantee with exponential-backoff retries.

## Lifecycle

```
  /facilitator/settle            apps/api worker             your endpoint
  ──────────────────►   enqueue   ────────────►   HTTP POST  ────────────►
                                                  + HMAC sig
                                                  + Event-Id
                                                                ◄────────
                                                                 2xx = ok
                                                                 4xx = drop (no retry)
                                                                 5xx/timeout = retry
```

## Event types (v1)

| Type                | When | `data.object` |
|---------------------|------|---------------|
| `settle.succeeded`  | facilitator_payments.status moved to `settled` | full settle row |
| `settle.failed`     | facilitator_payments.status moved to `failed`  | full settle row + error_code/error_message |

More event types (key.*, invoice.*) deferred to a later Sub-task.

## Payload envelope

```json
{
  "id": "evt_5a0c1e3f-2b4d-4f9e-8b6a-7d2c8f4e1a2b",
  "type": "settle.succeeded",
  "created": 1700000000,
  "data": {
    "object": {
      "id": "fpay_01HX9YZ...",
      "resource_key_id": "reskey_78c4ce3d",
      "network": "eip155:8453",
      "asset": "USDC",
      "scheme": "exact",
      "gross_amount": "1000",
      "fee_amount": "3",
      "net_amount": "997",
      "payer": "0x...",
      "recipient": "0x...",
      "adapter_used": "coinbase-cdp",
      "tx_hash": "0x...",
      "status": "settled",
      "error_code": null,
      "error_message": null,
      "created_at": "2026-05-29T18:00:00.000Z",
      "settled_at": "2026-05-29T18:00:04.000Z"
    }
  },
  "source": "suverse-pay"
}
```

Amounts are atomic units (USDC = 6 decimals → multiply by 1e-6 to get
USD). `id` is unique per delivery — use it for receiver-side
idempotency (the same id reappears on every retry attempt).

## Headers we send

| Header                       | Value | Notes |
|------------------------------|-------|-------|
| `Content-Type`               | `application/json` | Always. |
| `User-Agent`                 | `suverse-pay/1.0 (+https://suverse-pay.suverse.io)` | For your log filters. |
| `X-Suverse-Pay-Signature`    | `t=<unix_sec>,v1=<hex>` | HMAC-SHA256, see below. |
| `X-Suverse-Pay-Event-Id`     | `evt_<uuid>` | Dedupe key. |
| `X-Suverse-Pay-Event-Type`   | `settle.succeeded` \| `settle.failed` | Convenience — same as `body.type`. |

## Signature verification (REQUIRED)

The signing secret is the `whsec_*` string shown EXACTLY ONCE when
you create the endpoint in the dashboard. Store it server-side; never
ship it to the browser.

To verify a request:

1. Read `X-Suverse-Pay-Signature` — split on `,`, parse `t=<int>` and `v1=<hex>`.
2. Compute `HMAC_SHA256(secret, "<t>.<raw_body>")` as hex.
3. Compare with `v1` using a **constant-time** equality function.
4. Reject if `|now - t| > 300` seconds (replay window).

### Node.js receiver (Express)

```js
import express from "express";
import crypto from "node:crypto";

const SECRET = process.env.SUVERSE_PAY_WEBHOOK_SECRET; // "whsec_..."
const app = express();

// CRUCIAL: capture the raw body bytes BEFORE any JSON parsing.
app.post(
  "/webhooks/suverse",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const header = req.header("X-Suverse-Pay-Signature");
    if (!header || !verify(header, req.body, SECRET)) {
      return res.status(400).send("invalid signature");
    }
    const event = JSON.parse(req.body.toString("utf8"));
    // Idempotency: dedupe on event.id
    if (alreadyProcessed(event.id)) return res.status(200).send("ok");

    switch (event.type) {
      case "settle.succeeded":
        handleSettleSucceeded(event.data.object);
        break;
      case "settle.failed":
        handleSettleFailed(event.data.object);
        break;
    }
    res.status(200).send("ok");
  },
);

function verify(header, rawBody, secret) {
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=")),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${rawBody.toString("utf8")}`)
    .digest("hex");
  if (expected.length !== (parts.v1 ?? "").length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(parts.v1, "hex"),
  );
}
```

### Python receiver (Flask)

```python
import hashlib
import hmac
import os
import time
from flask import Flask, request, abort

SECRET = os.environ["SUVERSE_PAY_WEBHOOK_SECRET"].encode()
app = Flask(__name__)

@app.post("/webhooks/suverse")
def receive():
    raw = request.get_data()  # bytes — DO NOT use request.json
    header = request.headers.get("X-Suverse-Pay-Signature", "")
    if not verify(header, raw):
        abort(400, "invalid signature")
    event = request.get_json()
    if already_processed(event["id"]):
        return "ok", 200
    if event["type"] == "settle.succeeded":
        handle_settle_succeeded(event["data"]["object"])
    elif event["type"] == "settle.failed":
        handle_settle_failed(event["data"]["object"])
    return "ok", 200

def verify(header: str, raw: bytes) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t = int(parts.get("t", "0"))
    except ValueError:
        return False
    if abs(time.time() - t) > 300:
        return False
    signed = f"{t}.{raw.decode('utf-8')}".encode()
    expected = hmac.new(SECRET, signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

## Retry policy

| Response | Outcome |
|---|---|
| `2xx` | Success. Delivery row → `success`, done. |
| `4xx` (except `408`, `429`) | Permanent failure. Delivery row → `dead`. No retry. |
| `5xx`, `408`, `429`, network error, timeout (10s) | Retryable. |

Backoff schedule (6 retries after the initial attempt, max 7 tries
total):

```
attempt 1: immediate
attempt 2: + 30s
attempt 3: + 2m
attempt 4: + 10m
attempt 5: + 1h
attempt 6: + 6h
attempt 7: + 24h
```

After attempt 7 fails, the delivery is marked `dead`. You can
manually re-queue it from the dashboard&rsquo;s deliveries view —
manual retry bumps `max_attempts` so a dead delivery gets a fresh
3-retry budget.

## Idempotency

Suverse Pay sends every event **at least once**. On rare worker
crashes between "we POSTed and got a 2xx" and "we wrote
`status=success` to Postgres", the same event will resend later.
Your handler MUST dedupe on `X-Suverse-Pay-Event-Id` (= the `id`
field in the payload). A 5-minute Redis SETNX or a unique-index on
`(event_id)` in your own DB is sufficient.

Order is **NOT guaranteed** — a `settle.failed` for one settle could
arrive after a `settle.succeeded` for a later settle. Each event
carries `created` (unix seconds) and `data.object.created_at` (ISO)
for application-level ordering.

## Security model

- The signing secret is stored in PLAINTEXT in our database because
  HMAC signing requires the secret bytes themselves. Same model as
  Stripe&rsquo;s `whsec_*`. If our DB is breached, treat every
  signing secret as compromised and rotate via the dashboard
  (delete + recreate the endpoint).
- Endpoints must use HTTPS in production. The dashboard does not
  enforce this at the moment (HTTP URLs are accepted for local dev /
  ngrok tunnels) — you SHOULD only register HTTPS endpoints, and a
  future Sub-task will reject HTTP for any URL not matching
  `localhost` / `127.0.0.1`.
- The `replay window` is 5 minutes — the default Stripe value and
  large enough to survive normal clock skew while small enough to
  defeat capture-and-replay.
