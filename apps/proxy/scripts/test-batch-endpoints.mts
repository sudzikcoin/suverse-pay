// Generic live-settle smoke harness for a pipeline batch. Reads the
// manifest the wrap-batch pipeline emitted and settles a chosen subset
// (or all) on Base, proving the declarative endpoints are payable
// end-to-end. Mirrors test-macro-endpoints.mts.
//
// Env:
//   PAYER_BASE_PRIVATE_KEY_PATH   0x-prefixed 64-hex secret file.
//   PROXY_BASE_URL                override (default proxy.suverse.io).
//   BATCH                         batch id (default batch-001).
//   ONLY                          comma slugs to settle (default: all).
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SuverseClient } from "@suverselabs/x402-client";

const BASE_NETWORK = "eip155:8453";
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadKey(): `0x${string}` {
  const path = process.env.PAYER_BASE_PRIVATE_KEY_PATH;
  if (!path) throw new Error("set PAYER_BASE_PRIVATE_KEY_PATH");
  const raw = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error("key file must be 0x + 64 hex");
  return raw as `0x${string}`;
}

interface ManifestRow { slug: string; priceUsdc: string; category: string; sampleRequest: Record<string, unknown>; }

async function main(): Promise<void> {
  const batch = process.env.BATCH ?? "batch-001";
  const proxyBase = process.env.PROXY_BASE_URL ?? "https://proxy.suverse.io";
  const manifest: ManifestRow[] = JSON.parse(
    readFileSync(resolve(__dirname, "..", "..", "..", "scripts", "pipeline", `manifest-${batch}.json`), "utf8"),
  );
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
  const rows = only ? manifest.filter((r) => only.has(r.slug)) : manifest;

  const client = new SuverseClient({
    wallets: { evm: loadKey() },
    preferences: { preferredNetwork: BASE_NETWORK },
  });

  let ok = 0;
  for (const ep of rows) {
    const url = `${proxyBase}/v1/data/${ep.slug}`;
    console.log(`\n▶ ${ep.slug} ($${ep.priceUsdc}) body=${JSON.stringify(ep.sampleRequest)}`);
    const t0 = Date.now();
    try {
      const result = await client.fetch<unknown>(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ep.sampleRequest),
      });
      const ms = Date.now() - t0;
      const dataStr = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
      console.log(`  ✓ HTTP 200 in ${ms}ms  tx=${result.payment.txHash ?? "(none)"}  paid=${result.payment.amount} on ${result.payment.network}`);
      console.log(`  preview: ${dataStr.slice(0, 280)}${dataStr.length > 280 ? " …" : ""}`);
      ok++;
    } catch (err) {
      console.log(`  ✗ FAIL: ${(err as Error).message}`);
    }
  }
  console.log(`\n${ok}/${rows.length} settled`);
  if (ok < rows.length) process.exit(1);
}

main().catch((e: unknown) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
