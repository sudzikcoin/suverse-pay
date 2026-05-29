# Observability — internal Grafana + Prometheus

Phase 4 Block 1 Sub-task 4. Operator-facing dashboard, not customer-
facing analytics — that's Phase 5+.

The observability stack is **opt-in**: the postgres + redis services
come up on a plain `docker compose up -d`; grafana + prometheus are
behind the `observability` Docker Compose profile so a normal `pnpm
test` / dev loop does not pull two extra images.

## Quick start

```bash
# Bring up the observability stack
docker compose --profile observability up -d grafana prometheus

# Verify both healthy
curl -s http://localhost:3030/api/health
curl -s http://localhost:9090/-/ready

# Open the dashboard
open http://localhost:3030    # macOS
# username: admin   password: admin   (change via GRAFANA_ADMIN_PASSWORD env)
```

The "Facilitator Observability" dashboard auto-loads on first start
via `grafana/provisioning/dashboards/dashboards.yml`.

## Ports

| Service     | Container port | Host port | Override env var |
| ----------- | -------------- | --------- | ---------------- |
| Grafana     | 3000           | 3030      | `GRAFANA_PORT`   |
| Prometheus  | 9090           | 9090      | `PROMETHEUS_PORT` |
| Postgres    | 5432           | 5433      | `POSTGRES_PORT`  |
| Redis       | 6379           | 6380      | `REDIS_PORT`     |
| apps/api    | —              | 3000      | `API_PORT`       |

Grafana is on **3030**, not the conventional 3000 (that's our API) or
3001 (collides with LaunchLoop on this host). If you redeploy, set
`GRAFANA_PORT` in `.env` or directly in the shell before
`docker compose up`.

## What's wired up

```
                  ┌───────────────────────┐
                  │  apps/api (host:3000) │
                  │  /metrics  (Prom)     │
                  │  /metrics/summary     │
                  └──────────┬────────────┘
                             │ scrape every 15s
                             ▼
┌──────────────────────────────────────────┐
│  Prometheus (host:9090)                  │
│  retention 30d                           │
└──────────────────────────────────────────┘
                             ▲
                             │ datasource: Prometheus
                             │
┌──────────────────────────────────────────┐
│  Grafana (host:3030)                     │
│  datasource: Postgres (direct queries)   │
└──────────────────────────────────────────┘
```

apps/api runs on the host, not in a container. Prometheus reaches it
over `host.docker.internal:3000` (set via `extra_hosts` in
docker-compose.yml). If you containerize apps/api later, swap the
Prometheus target to the service name.

## Metrics exposed at /metrics

Defined in `apps/api/src/lib/metrics.ts`. All values **except** the
rate-limit counter come from a Postgres roll-up cron
(`metrics-refresher.ts`) that runs every 15s — absolute cumulative
values, not in-process counters. Restart-safe.

| Metric | Labels | Source |
| --- | --- | --- |
| `facilitator_settle_total` | `adapter, network, status` | `facilitator_payments` GROUP BY |
| `facilitator_verify_total` | `adapter, network, status` | `payment_attempts` JOIN `payments` |
| `facilitator_failover_events_total` | `from_adapter, to_adapter, network` | `facilitator_failover_events` JOIN `facilitator_payments` |
| `facilitator_rate_limit_hits_total` | `resource_key_label` | In-process Counter in `routes/facilitator.ts` (resets on restart) |
| `adapter_health` | `adapter` | Latest `provider_health_checks` row per provider |
| `payment_amount_sum` | `network, asset` | `SUM(amount)` for `status='settled'` |
| `payment_amount_count` | `network, asset` | `COUNT(*)` for `status='settled'` |
| `metrics_refresher_last_run_seconds` | none | Last successful refresher tick (unix epoch) |

Plus `process_*` / `nodejs_*` defaults from `prom-client.collectDefaultMetrics`.

> **Important note on `_total` semantics.** prom-client's `Counter`
> only supports `.inc()`. Most of our metrics are sourced from
> Postgres aggregates rather than per-event hooks, so they are
> implemented as `Gauge.set()` even though the metric name carries
> the `_total` suffix. Grafana `rate()` won't behave intuitively
> across resets — use `increase(metric[window])` instead, which
> correctly handles monotonic gauges.

## Dashboard panels

All in one dashboard, organized in 4 rows.

### Row 1 — System health
1. **Adapter health** — stat per adapter, green if last health-check `healthy`, red otherwise.
2. **Settles (24h)** — single stat, sum across all adapters.
3. **Volume (USDC, lifetime)** — sum of `payment_amount_sum` divided by 1e6 (USDC has 6 decimals).
4. **Active resource API keys** — single stat, direct Postgres query (`SELECT COUNT(*) FROM resource_api_keys WHERE is_active`).

### Row 2 — Settle activity
5. **Settles per hour, by adapter** — stacked timeseries, `increase()` over 1h windows.
6. **Settles by network (24h)** — donut chart, settled status only.
7. **Settles by status (rolling 5m)** — stacked timeseries, all three statuses (settled / failed / pending).

### Row 3 — Failover and errors
8. **Failover events (24h)** — table from Postgres with `created_at`, `from_adapter → to_adapter`, network, error code, payment id.
9. **Top errors by adapter (24h)** — table grouped by `(adapter_used, error_code)`.
10. **Rate-limit hits per resource key (since process start)** — horizontal bar chart.

### Row 4 — Resource keys
11. **Top resource keys by volume (7d)** — Postgres query with `volume_usdc`, `settled`, `failed` per (label, network).
12. **Per-resource-key settle counts (lifetime)** — table.

Default time range: **last 6h**. Default refresh: **30s**. Dashboard
fits a 1920×1080 laptop screen.

## Extending the dashboard

The dashboard is provisioned read-only from
`grafana/dashboards/facilitator.json`, but Grafana provisioning
allows UI edits (`allowUiUpdates: true` in
`provisioning/dashboards/dashboards.yml`). Workflow:

1. Edit the dashboard in the Grafana UI.
2. Open Dashboard → Settings → JSON Model.
3. Copy it back to `grafana/dashboards/facilitator.json`.
4. Commit. The next `docker compose restart grafana` will re-provision
   from the file.

To add a brand-new dashboard, just drop another JSON file in
`grafana/dashboards/`. The provisioner picks it up on the next 30s
update tick — no Grafana restart needed.

## Adding a new metric

1. Define the `Gauge` (or `Counter` if you'll instrument inline) in
   `apps/api/src/lib/metrics.ts`.
2. Either:
   - Add a `refresh*()` method to `MetricsRefresher` with the SQL
     roll-up, OR
   - Wire `.inc()` from the code path that emits the event (see how
     `facilitatorRateLimitHitsTotal` hooks into
     `routes/facilitator.ts`).
3. Add a panel in `grafana/dashboards/facilitator.json` (or via the
   UI, then export, see above).

## Operator alerts (not configured yet)

The dashboard is read-only today — no alert rules. Phase 5 candidates:

- `metrics_refresher_last_run_seconds < time() - 60` → refresher stuck.
- `adapter_health == 0` for > 5m on any provider → drop from rotation.
- Sudden spike in `facilitator_rate_limit_hits_total` for one
  resource key → abusive client, investigate.

Alerts will live in `grafana/provisioning/alerting/`. Not in scope
for Sub-task 4.

## Persistence

| Volume                | What it holds                          |
| --------------------- | -------------------------------------- |
| `suverse_pay_prom`    | Prometheus TSDB (30d retention)        |
| `suverse_pay_grafana` | Grafana SQLite (users, last-viewed dashboard, etc.) |
| `suverse_pay_pg`      | Application Postgres                   |
| `suverse_pay_redis`   | Rate-limit + idempotency cache         |

Killing and recreating only the observability volumes is safe:

```bash
docker compose --profile observability down
docker volume rm suverse-pay_suverse_pay_prom suverse-pay_suverse_pay_grafana
docker compose --profile observability up -d grafana prometheus
```

Resets metrics history + Grafana user prefs. Does NOT touch postgres /
redis.

## Troubleshooting

**Grafana dashboard shows "no data"**
- Check `curl http://localhost:3000/metrics` returns prom-client text. If 404, apps/api hasn't been rebuilt since Sub-task 4.
- Check `metrics_refresher_last_run_seconds` is non-zero and within the last minute — `curl http://localhost:3000/metrics | grep metrics_refresher_last_run_seconds`.
- Check Prometheus targets: http://localhost:9090/targets — `suverse-pay-api` should be `UP`.
- If `DOWN`: Prometheus can't reach `host.docker.internal:3000`. On Linux this needs the `host-gateway` extra_hosts (already configured in docker-compose); on macOS it's automatic.

**Postgres datasource panels are empty**
- Check Grafana → Connections → Data sources → SuversePayPostgres → "Test". If it fails: the `postgres` service is on a different docker network than grafana. Recreate the stack: `docker compose --profile observability down && docker compose --profile observability up -d`.

**`facilitator_settle_total` stuck at 0**
- The dev DB is empty. Run `bash scripts/smoke/facilitator-mocked/run-all.sh` to populate; then wait 15s for the refresher to tick.

**Grafana port collision**
- Default `:3030` was picked to avoid `:3000` (apps/api) and `:3001` (other Next.js apps on this host). Set `GRAFANA_PORT` before `up`.
