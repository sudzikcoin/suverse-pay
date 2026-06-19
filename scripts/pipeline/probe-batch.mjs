#!/usr/bin/env node
// Upstream de-risk probe: rebuilds the EXACT URL the declarative engine
// would build for each row's sampleRequest, fetches it, and reports
// status + preview. Pre-seed safety net — catches param/encoding/UA
// bugs before any buyer pays. Usage: node probe-batch.mjs <batch.json>
import { readFileSync } from "node:fs";
const rows = JSON.parse(readFileSync(process.argv[2], "utf8"));

const xf = (v, t) => {
  let s = Array.isArray(v) ? v.map(String).join(",") : String(v);
  if (t === "upper") return s.toUpperCase();
  if (t === "lower") return s.toLowerCase();
  if (t === "pad10") return s.replace(/\D/g, "").padStart(10, "0").slice(-10);
  return s;
};
function buildUrl(r) {
  let url = r.upstream.url;
  const q = new URLSearchParams();
  for (const [f, p] of Object.entries(r.params)) {
    let raw = r.sampleRequest[f];
    if (raw === undefined || raw === "") { if (p.default !== undefined) raw = p.default; else continue; }
    const val = xf(raw, p.transform);
    if (p.in === "path") url = url.replace(`{${f}}`, encodeURIComponent(val));
    else q.set(p.upstreamName ?? f, val);
  }
  for (const [k, v] of Object.entries(r.upstream.staticQuery ?? {})) q.set(k, v);
  const qs = q.toString();
  if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  return url;
}

let ok = 0, bad = 0;
for (const r of rows) {
  const url = buildUrl(r);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { accept: "application/json", ...(r.upstream.headers ?? {}) }, signal: ctrl.signal });
    clearTimeout(t);
    const txt = (await res.text()).slice(0, 70).replace(/\s+/g, " ");
    const good = res.status === 200;
    console.log(`${good ? "OK " : "!! "}${String(res.status).padEnd(3)} ${r.slug.padEnd(30)} ${txt}`);
    good ? ok++ : bad++;
  } catch (e) {
    clearTimeout(t);
    console.log(`!! ERR ${r.slug.padEnd(30)} ${e.name}:${e.message}`);
    bad++;
  }
}
console.log(`\n${ok} OK / ${bad} need attention (of ${rows.length})`);
