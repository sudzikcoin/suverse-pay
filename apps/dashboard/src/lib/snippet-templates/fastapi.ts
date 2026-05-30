/**
 * FastAPI snippet. Manual middleware implementation — the
 * companion `suverse-pay-x402-server` Python package will replace
 * this body in a follow-up sub-task, but the wire-format and
 * facilitator URL are stable so this code keeps working unchanged.
 */

import type { RenderedSnippet, TemplateInput } from "./types.js";

export function renderFastAPI(input: TemplateInput): RenderedSnippet {
  const acceptedPaymentsBlock = input.acceptedPayments
    .map(
      (p) => `    {
        # ${p.networkLabel}
        "scheme": "exact",
        "network": "${p.network}",
        "asset": "${p.asset}",
        "payTo": "${p.payTo}",
        "maxAmountRequired": "${p.maxAmountRequired}",
    }`,
    )
    .join(",\n");

  const description = input.description ?? "";
  const descriptionJson = JSON.stringify(description);

  const code = `# Suverse Pay — FastAPI integration snippet
# Generated for resource key ${input.keyId} on ${input.timestamp}
#
# NOTE: a managed Python package (suverse-pay-x402-server) is coming
# in the next sub-task. For now the protocol is implemented inline —
# the wire format is stable, so this code will keep working when the
# package ships; you'll just be able to delete the helper class.
#
# 1. pip install fastapi uvicorn httpx
# 2. export SUVERSE_PAY_API_KEY=sup_live_<paste-yours-here>
# 3. uvicorn server:app --host 0.0.0.0 --port 3000

import base64
import json
import os
import uuid
from typing import Any

import httpx
from fastapi import FastAPI, Request, Response

FACILITATOR = "${input.facilitatorUrl}"
API_KEY = os.environ["SUVERSE_PAY_API_KEY"]

ACCEPTED_PAYMENTS = [
${acceptedPaymentsBlock},
]

CHALLENGE_DESCRIPTION = ${descriptionJson}


def build_challenge(resource_url: str, error: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "x402Version": 2,
        "accepts": [{**p, "resource": resource_url} for p in ACCEPTED_PAYMENTS],
    }
    if error:
        body["error"] = error
    if CHALLENGE_DESCRIPTION:
        body["description"] = CHALLENGE_DESCRIPTION
    return body


def decode_payment_header(value: str) -> dict[str, Any]:
    raw = base64.b64decode(value.strip()).decode("utf-8")
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("X-Payment must decode to an object")
    return parsed


async def call_facilitator(
    endpoint: str,
    payment_payload: dict[str, Any],
    requirement: dict[str, Any],
    idempotency_key: str,
) -> dict[str, Any]:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if endpoint == "settle":
        headers["Authorization"] = f"Bearer {API_KEY}"
        headers["Idempotency-Key"] = idempotency_key
    body = {
        "paymentPayload": payment_payload,
        "paymentRequirements": {
            "scheme": requirement["scheme"],
            "network": requirement["network"],
            "asset": requirement["asset"],
            "payTo": requirement["payTo"],
            "maxAmountRequired": requirement["maxAmountRequired"],
        },
    }
    url = f"{FACILITATOR.rstrip('/')}/facilitator/{endpoint}"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=body, headers=headers)
    data = resp.json()
    if not resp.is_success:
        raise RuntimeError(f"facilitator {endpoint}: HTTP {resp.status_code}: {data}")
    return data


async def require_payment(request: Request) -> dict[str, Any] | Response:
    header = request.headers.get("x-payment")
    resource_url = str(request.url)
    if not header:
        return Response(
            status_code=402,
            content=json.dumps(build_challenge(resource_url)),
            media_type="application/json",
        )
    try:
        decoded = decode_payment_header(header)
    except Exception as exc:
        return Response(
            status_code=400,
            content=json.dumps(build_challenge(resource_url, str(exc))),
            media_type="application/json",
        )
    requirement = next(
        (
            p
            for p in ACCEPTED_PAYMENTS
            if p["scheme"] == decoded.get("scheme") and p["network"] == decoded.get("network")
        ),
        None,
    )
    if requirement is None:
        return Response(
            status_code=402,
            content=json.dumps(
                build_challenge(resource_url, "no matching requirement")
            ),
            media_type="application/json",
        )
    idempotency_key = request.headers.get("idempotency-key") or str(uuid.uuid4())
    verify = await call_facilitator("verify", decoded, requirement, idempotency_key)
    if not verify.get("isValid"):
        reason = verify.get("invalidReason", "verify_failed")
        return Response(
            status_code=402,
            content=json.dumps(build_challenge(resource_url, reason)),
            media_type="application/json",
        )
    settle = await call_facilitator("settle", decoded, requirement, idempotency_key)
    if not settle.get("success"):
        reason = settle.get("errorReason", "settle_failed")
        return Response(
            status_code=402,
            content=json.dumps(build_challenge(resource_url, reason)),
            media_type="application/json",
        )
    return {
        "payer": settle.get("payer") or verify.get("payer"),
        "network": requirement["network"],
        "asset": requirement["asset"],
        "amount": requirement["maxAmountRequired"],
        "txHash": settle.get("transaction") or settle.get("txHash"),
        "raw": settle,
    }


app = FastAPI()


@app.get("/paid")
async def paid(request: Request) -> Any:
    payment = await require_payment(request)
    if isinstance(payment, Response):
        return payment
    return {
        "result": "your paid response goes here",
        "paidBy": payment["payer"],
        "txHash": payment["txHash"],
    }
`;

  return {
    framework: "fastapi",
    language: "python",
    code,
    envVars: ["SUVERSE_PAY_API_KEY=sup_live_<paste-yours-here>"],
    install: "pip install fastapi uvicorn httpx",
    middlewareStatus: "placeholder",
  };
}
