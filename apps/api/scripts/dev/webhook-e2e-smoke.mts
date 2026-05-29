/**
 * Phase 5 Block 4 Sub-task 4 — webhooks E2E smoke.
 *
 * What it does:
 *   1. Mints a fresh webhook.site URL (free, anonymous, lasts 7d).
 *   2. Looks up the operator's dashboard user + linked resource key.
 *   3. Creates a webhook_endpoints row pointing at webhook.site.
 *   4. Inserts a SYNTHETIC settled facilitator_payment row.
 *   5. Calls enqueueSettleEvent — the same code path the live settle
 *      handler uses after finalizeFacilitatorPayment.
 *   6. Waits a few seconds for the in-process BullMQ Worker (running
 *      inside apps/api on :3000) to consume the job + POST to
 *      webhook.site with our HMAC-SHA256 signature.
 *   7. Reads back webhook_deliveries to confirm status='success'.
 *   8. Fetches webhook.site's request log via their API + prints
 *      the headers we sent (signature, event id, event type).
 *   9. Cleanup: deletes the endpoint + the synth settle row + reports
 *      what was left behind for the dashboard demo.
 *
 * Usage: from repo root
 *   set -a && source .env && set +a
 *   pnpm tsx scripts/dev/webhook-e2e-smoke.ts
 *
 * Idempotent: every run mints a fresh webhook.site URL + a fresh
 * (endpoint, settle) pair, so re-running doesn't double-deliver.
 */

import { setTimeout as sleep } from "node:timers/promises";
import {
  createWebhookEndpoint,
  createWebhookQueue,
  enqueueSettleEvent,
} from "@suverse-pay/webhooks";
import pg from "pg";

const TEST_USER_EMAIL =
  process.env.WEBHOOK_SMOKE_USER_EMAIL ?? "sudzikgroup@gmail.com";

interface WebhookSiteToken {
  uuid: string;
}

interface WebhookSiteRequest {
  method: string;
  headers: Record<string, string[] | string>;
  content: string;
  created_at: string;
}

async function mintWebhookSite(): Promise<{ uuid: string; receiverUrl: string; viewUrl: string }> {
  const res = await fetch("https://webhook.site/token", { method: "POST" });
  if (!res.ok) throw new Error(`webhook.site token mint failed: ${res.status}`);
  const t = (await res.json()) as WebhookSiteToken;
  return {
    uuid: t.uuid,
    receiverUrl: `https://webhook.site/${t.uuid}`,
    viewUrl: `https://webhook.site/#!/${t.uuid}`,
  };
}

async function fetchWebhookSiteRequests(uuid: string): Promise<WebhookSiteRequest[]> {
  const res = await fetch(`https://webhook.site/token/${uuid}/requests`);
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: WebhookSiteRequest[] };
  return body.data ?? [];
}

function headerValue(
  headers: Record<string, string[] | string>,
  key: string,
): string | undefined {
  const v = headers[key.toLowerCase()] ?? headers[key];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (dbUrl === undefined || redisUrl === undefined) {
    throw new Error("DATABASE_URL and REDIS_URL must be set in env");
  }

  console.log("=== Suverse Pay webhooks E2E smoke ===\n");

  // Step 1 — webhook.site
  const ws = await mintWebhookSite();
  console.log("[1] webhook.site receiver:", ws.receiverUrl);
  console.log("    browser view:        ", ws.viewUrl);

  // Step 2 — DB lookup
  const pool = new pg.Pool({ connectionString: dbUrl });
  const userQ = await pool.query<{ id: string }>(
    `SELECT id FROM dashboard_users WHERE email = $1 LIMIT 1`,
    [TEST_USER_EMAIL],
  );
  if (userQ.rows.length === 0) {
    throw new Error(`dashboard user with email ${TEST_USER_EMAIL} not found`);
  }
  const userId = userQ.rows[0]!.id;
  const keyQ = await pool.query<{ resource_key_id: string; label: string }>(
    `SELECT l.resource_key_id, k.label
       FROM dashboard_user_resource_keys l
       JOIN resource_api_keys k ON k.id = l.resource_key_id
      WHERE l.user_id = $1 AND k.is_active = TRUE
      ORDER BY l.linked_at DESC
      LIMIT 1`,
    [userId],
  );
  if (keyQ.rows.length === 0) {
    throw new Error(
      `dashboard user ${TEST_USER_EMAIL} has no linked active resource key`,
    );
  }
  const { resource_key_id: resourceKeyId, label: keyLabel } = keyQ.rows[0]!;
  console.log("[2] dashboard user:    ", userId, `(${TEST_USER_EMAIL})`);
  console.log("    linked resource key:", resourceKeyId, `("${keyLabel}")`);

  // Step 3 — create endpoint row
  const { row: endpoint, secretPlaintext } = await createWebhookEndpoint({
    client: pool,
    dashboardUserId: userId,
    url: ws.receiverUrl,
    description: "E2E smoke (auto-cleanup at end)",
  });
  console.log("[3] webhook endpoint:   ", endpoint.id);
  console.log("    signing secret:     ", secretPlaintext);

  // Step 4 — synthetic settled facilitator_payment row
  const settleId = `fpay_SMOKE_${Date.now()}`;
  const txHash = "0x" + "ab".repeat(32);
  const payer = "0x000000000000000000000000000000000000c0de";
  await pool.query(
    `INSERT INTO facilitator_payments (
       id, resource_key_id, idempotency_key, network, asset, scheme,
       amount, gross_amount, fee_amount, net_amount, recipient,
       adapter_used, tx_hash, payer, status, created_at, settled_at
     ) VALUES (
       $1, $2, $3, 'eip155:8453', 'USDC', 'exact',
       '1000', 1000::numeric, 3::numeric, 997::numeric,
       '0x000000000000000000000000000000000000beef',
       'coinbase-cdp', $4, $5, 'settled', NOW(), NOW()
     )`,
    [settleId, resourceKeyId, `smoke_${Date.now()}`, txHash, payer],
  );
  console.log("[4] synth settle:       ", settleId);

  // Step 5 — enqueue (mirrors apps/api settle handler)
  const parsedRedis = new URL(redisUrl);
  const queue = createWebhookQueue({
    host: parsedRedis.hostname,
    port: parsedRedis.port.length > 0 ? Number(parsedRedis.port) : 6379,
  });
  const enqueueResult = await enqueueSettleEvent({
    client: pool,
    queue,
    eventType: "settle.succeeded",
    settle: {
      id: settleId,
      resource_key_id: resourceKeyId,
      network: "eip155:8453",
      asset: "USDC",
      scheme: "exact",
      gross_amount: "1000",
      fee_amount: "3",
      net_amount: "997",
      payer,
      recipient: "0x000000000000000000000000000000000000beef",
      adapter_used: "coinbase-cdp",
      tx_hash: txHash,
      status: "settled",
      error_code: null,
      error_message: null,
      created_at: new Date().toISOString(),
      settled_at: new Date().toISOString(),
    },
  });
  console.log("[5] enqueueSettleEvent fanned out to", enqueueResult.fannedOutTo, "endpoint(s)");
  console.log("    delivery ids:", enqueueResult.deliveryIds.join(", "));

  // Step 6 — wait for worker
  console.log("\n[6] waiting 6s for in-process Worker to deliver...");
  await sleep(6000);

  // Step 7 — read back delivery state
  const delQ = await pool.query<{
    id: string;
    status: string;
    attempts: number;
    last_response_code: number | null;
    last_error: string | null;
  }>(
    `SELECT id, status, attempts, last_response_code, last_error
       FROM webhook_deliveries
      WHERE endpoint_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [endpoint.id],
  );
  const delivery = delQ.rows[0];
  if (delivery === undefined) {
    console.error("[7] FAIL: no delivery row found");
  } else {
    console.log(
      `[7] delivery row: status=${delivery.status} attempts=${delivery.attempts}`,
      `last_response_code=${delivery.last_response_code ?? "(null)"}`,
      `last_error=${delivery.last_error ?? "(null)"}`,
    );
  }

  // Step 8 — webhook.site request log
  const reqs = await fetchWebhookSiteRequests(ws.uuid);
  console.log(`[8] webhook.site received ${reqs.length} HTTP request(s)`);
  if (reqs.length > 0) {
    const r = reqs[0]!;
    console.log("    method:        ", r.method);
    console.log("    X-Suverse-Pay-Signature:", headerValue(r.headers, "X-Suverse-Pay-Signature"));
    console.log("    X-Suverse-Pay-Event-Id: ", headerValue(r.headers, "X-Suverse-Pay-Event-Id"));
    console.log("    X-Suverse-Pay-Event-Type:", headerValue(r.headers, "X-Suverse-Pay-Event-Type"));
    console.log("    User-Agent:    ", headerValue(r.headers, "User-Agent"));
    const body = r.content;
    console.log("    body length:   ", body.length, "bytes");
    console.log("    body preview:  ", body.slice(0, 200) + (body.length > 200 ? "..." : ""));
  }

  // Step 9 — cleanup
  console.log("\n[9] cleanup...");
  await pool.query(
    `DELETE FROM webhook_endpoints WHERE id = $1`,
    [endpoint.id],
  );
  await pool.query(
    `DELETE FROM facilitator_payments WHERE id = $1`,
    [settleId],
  );
  console.log("    endpoint + delivery rows + synth settle deleted");

  await queue.close();
  await pool.end();

  console.log("\n=== SMOKE COMPLETE ===");
  console.log(`Open ${ws.viewUrl} in a browser to see the request inspector.`);
}

main().catch((err) => {
  console.error("\n❌ smoke failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
