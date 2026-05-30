# Seller onboarding — operator runbook

Companion to the dashboard's `/dashboard/keys/[id]/configure` flow.
Covers everything the operator must do **once** to make the seller-
self-service path work end-to-end.

This is the runbook a human (you, the operator) follows. The seller
themselves never needs to know about any of it — they just open the
dashboard, hit Configure, and copy a snippet.

## What this enables

1. A seller signs in to `https://suverse-pay.suverse.io` with OAuth.
2. They create a resource API key.
3. They click **Configure** → fill in the 7-section form → save.
4. They copy the generated Express / Fastify / FastAPI snippet into
   their own server.
5. Their server exposes a paid endpoint that talks to
   `https://facilitator.suverse.io` to verify + settle payments.

Step 5 needs the facilitator subdomain to actually exist and be
reachable from the public internet — that's what this runbook sets
up.

## Prerequisite: DNS

A-record for `facilitator.suverse.io` → the server's public IP
(`185.218.126.38`). Add it through whichever DNS panel manages
`suverse.io`. Verify propagation:

```bash
dig +short facilitator.suverse.io @8.8.8.8
# Expected: 185.218.126.38
```

If empty, wait 5-30 minutes for propagation and try again.

## Nginx site config

The repo ships `deploy/nginx-facilitator.suverse.io.conf`. Apply it:

```bash
sudo cp deploy/nginx-facilitator.suverse.io.conf \
    /etc/nginx/sites-available/facilitator.suverse.io
sudo ln -sf ../sites-available/facilitator.suverse.io \
    /etc/nginx/sites-enabled/facilitator.suverse.io
sudo nginx -t
sudo systemctl reload nginx
```

`nginx -t` MUST pass before reload. If it errors with "duplicate
zone facilitator", another site file already declares the same
`limit_req_zone` — move it to `/etc/nginx/conf.d/zones.conf` and
delete the duplicate from this file.

## SSL via certbot

```bash
sudo certbot --nginx -d facilitator.suverse.io \
    --non-interactive --agree-tos \
    -m sudzikgroup@gmail.com --redirect
```

`--redirect` rewrites the `listen 80;` block to a permanent
http→https redirect. After certbot runs, the site config has both
managed-cert lines and a redirect server block at the bottom.

The certbot timer is already active from earlier deploys
(`systemctl status snap.certbot.renew.timer`) and will auto-renew
this cert ~30 days before its 90-day expiry.

## Smoke

```bash
curl -i https://facilitator.suverse.io/facilitator/health
# Expected: HTTP/2 200, body { "status":"ok", "x402Version":2 }

curl -s https://facilitator.suverse.io/facilitator/supported | jq '.supported | length'
# Expected: >= 30 (full route count varies as adapters are added/removed)

curl -i https://facilitator.suverse.io/
# Expected: HTTP/2 404 — root is intentionally not exposed.
```

## Suverse-pay app — make sure the facilitator API is running

The Fastify API on `127.0.0.1:3000` is what nginx proxies to. It's
NOT yet under pm2 (see `apps/api`'s "Operational gotcha" in
`STATUS.md`). For now, keep it alive with the same `tsx watch`
pattern other sessions used:

```bash
cd /home/govhub/suverse-pay
set -a && source .env && set +a
nohup pnpm --filter @suverse-pay/api dev > /tmp/suverse-pay-api.log 2>&1 &
```

(Until a future ops sub-task moves it under pm2 like the dashboard,
this needs to be re-run after every server reboot.)

Once pm2 is set up:

```bash
pm2 start --name suverse-pay-api --cwd /home/govhub/suverse-pay \
    pnpm -- --filter @suverse-pay/api dev
pm2 save
```

## Verify a seller can actually use it

Manual walk-through after the above is live:

1. Open `https://suverse-pay.suverse.io/dashboard` in a browser.
2. Create a new key labelled `walkthrough` and copy the `sup_live_…`
   plaintext.
3. Click **Configure** on the new key.
4. Tick **Base** under EVM, paste a Base address into "EVM wallet".
5. Set price to `0.07`, leave description empty.
6. Click **Save configuration** — the "Configured ✓" pill turns
   emerald and sections 06 + 07 unlock.
7. Open section 06 → Generate Express snippet. Verify the snippet's
   `payTo` matches the address you pasted and `maxAmountRequired`
   is `70000`.
8. Probe section 07 against any known x402 endpoint (e.g. the
   GovHub one at `https://api.suverse.io/v1/freight/parse_ratecon`)
   to confirm the probe path returns a populated check list.

## What's NOT covered by this sub-task

- Per-endpoint pricing (single default price per key in v1).
- A public discovery catalog of all configured sellers — the
  `description` field is stored but not yet surfaced.
- The Python middleware package — FastAPI snippets currently inline
  a manual implementation. Coming next.
- On-chain platform fee collection — fees are accounted for in the
  database, collection is out-of-band via the invoice CSV.

## Rollback

If a faulty config-route deploys and the dashboard becomes uneditable:

```bash
pm2 restart suverse-dashboard
```

If the nginx config breaks:

```bash
sudo rm /etc/nginx/sites-enabled/facilitator.suverse.io
sudo nginx -t && sudo systemctl reload nginx
```

The seller config rows live in `resource_server_configs` (migration
006). If you ever need to drop a single seller's config without
deleting their key:

```sql
DELETE FROM resource_server_configs WHERE resource_key_id = 'reskey_xxxxxxxx';
```

The `ON DELETE CASCADE` runs the other direction — revoking a key
deletes its config row. Configs on their own are safe to drop.
