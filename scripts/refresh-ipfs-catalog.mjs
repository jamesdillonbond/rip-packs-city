// scripts/refresh-ipfs-catalog.mjs
//
// One-command refresh of public.topshot_ipfs_assets from Dapper's IPFS
// Reference App dataset (announced 2026-06-08; see CLAUDE.md "Recent sessions"
// and docs/handoff-2026-06-09-ipfs-verified-media.md).
//
// The reference app (dapperlabs.github.io/dapperlabs-ipfs-reference-app) is a
// static Next.js build whose LARGEST _next/static/chunks/*.js bundle (~17 MB)
// embeds the full play->CID dataset as JSON.parse('...'). This script:
//   1. fetches the app HTML, discovers the largest chunk (hash rotates on
//      every Dapper redeploy — never hardcode it),
//   2. extracts + unescapes the single-quoted JSON literal,
//   3. groups assets to one row per (play_flow_id, set_uuid, parallel) with
//      per-type CID + pin-size columns,
//   4. POSTs rows in chunks of 1000 to the ipfs-catalog-loader edge function
//      (upsert on the unique key — safe to re-run any time).
//
// Usage (from the repo root, with .env.local holding the usual Supabase vars):
//   node scripts/refresh-ipfs-catalog.mjs
//
// Auth (2026-10-14, register R21 (c)): the loader is behind the shared Vault gate
// (supabase/functions/_shared/cron-gate.ts). This script fetches the loader's key AT RUN
// TIME through the SECURITY DEFINER rpc `cron_gate_key('ipfs-catalog-loader')`, using the
// service-role key it reads from .env.local, and sends it in the `x-rpc-gate-key` header.
// The key is never printed, never typed, never copied. ⛔ Do not go back to copying a token
// out of the deployed source: that is how this repo's gate keys leaked (2026-08-18).
//
// When to run: whenever Dapper refreshes their bundle (e.g. WNBA sets appear
// in the reference app, new series drop). The daily
// /api/admin/backfill-topshot-onchain-art cron covers editions.thumbnail_url /
// video_url independently from chain; this script keeps the CATALOG (edition-
// page IPFS badges, pin-your-collection exports) complete, including parallels
// and pin sizes which the on-chain resolver does not expose.

const APP_BASE = "https://dapperlabs.github.io/dapperlabs-ipfs-reference-app";
const LOADER_URL = "https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/ipfs-catalog-loader";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required (.env.local).");
  process.exit(1);
}

/** The loader's gate key, read from Vault at run time. Never logged. */
async function loaderKey() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/cron_gate_key`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ p_fn: "ipfs-catalog-loader" }),
  });
  if (!res.ok) throw new Error(`cron_gate_key http_${res.status} — is the service-role key current?`);
  const key = await res.json();
  if (typeof key !== "string" || key === "") throw new Error("cron_gate_key returned no key");
  return key;
}

const COL_FOR = {
  VIDEO: "video", VIDEO_SQUARE: "video_square", VIDEO_TALL: "video_tall",
  VIDEO_VERTICAL: "video_vertical", HERO: "hero", PLAYER: "player", IMAGE_PLAYER: "image_player",
};

async function discoverChunkUrl() {
  const res = await fetch(`${APP_BASE}/`);
  if (!res.ok) throw new Error(`index fetch http_${res.status}`);
  const html = await res.text();
  const chunks = [...new Set([...html.matchAll(/_next\/static\/chunks\/([a-z0-9]+\.js)/gi)].map((m) => m[0]))];
  let best = null, bestLen = 0;
  for (const c of chunks) {
    const h = await fetch(`${APP_BASE}/${c}`, { method: "HEAD" });
    const len = Number(h.headers.get("content-length") ?? 0);
    if (len > bestLen) { bestLen = len; best = `${APP_BASE}/${c}`; }
  }
  if (!best || bestLen < 1_000_000) throw new Error("no large data chunk found — has the app changed shape?");
  console.log(`data chunk: ${best} (${(bestLen / 1e6).toFixed(1)} MB)`);
  return best;
}

function extractDataset(js) {
  const marker = "JSON.parse('";
  const start = js.indexOf(marker);
  if (start < 0) throw new Error("JSON.parse marker not found — has the app changed shape?");
  let i = start + marker.length;
  const from = i;
  while (i < js.length) {
    if (js[i] === "\\") { i += 2; continue; }
    if (js[i] === "'") break;
    i++;
  }
  const raw = js.slice(from, i);
  let out = "";
  for (let j = 0; j < raw.length; j++) {
    if (raw[j] === "\\") {
      const n = raw[j + 1];
      if (n === "'") { out += "'"; j++; }
      else if (n === "\\") { out += "\\"; j++; }
      else out += raw[j];
    } else out += raw[j];
  }
  const data = JSON.parse(out);
  if (!Array.isArray(data)) throw new Error("dataset is not an array");
  return data;
}

function groupRows(data) {
  const rows = new Map();
  for (const p of data) {
    const playFlowId = Number(p?.flow_id);
    if (!Number.isFinite(playFlowId) || !p?.id) continue;
    for (const a of p.assets ?? []) {
      if (!a?.setId || !a?.ipfsCid) continue;
      const parallel = (a.parallel && String(a.parallel).trim()) || "Base";
      const k = `${playFlowId}|${a.setId}|${parallel}`;
      if (!rows.has(k)) {
        rows.set(k, {
          play_flow_id: playFlowId,
          set_flow_id: a.setFlowId != null && a.setFlowId !== "" ? Number(a.setFlowId) : null,
          play_uuid: p.id,
          set_uuid: a.setId,
          set_name: a.setName ?? null,
          rarity: a.rarity ?? null,
          series: a.series != null ? Number(a.series) : null,
          parallel,
          player_name: p.player_name ?? null,
        });
      }
      const r = rows.get(k);
      const c = COL_FOR[String(a.assetType)];
      if (c) {
        r[`${c}_cid`] = a.ipfsCid;
        if (a.pinSize != null) r[`${c}_pin_size`] = a.pinSize;
      }
    }
  }
  return [...rows.values()];
}

const chunkUrl = await discoverChunkUrl();
const js = await (await fetch(chunkUrl)).text();
const data = extractDataset(js);
const rows = groupRows(data);
console.log(`plays: ${data.length}, grouped rows: ${rows.length}`);

const GATE_KEY = await loaderKey();
let upserted = 0, failed = 0;
for (let i = 0; i < rows.length; i += 1000) {
  const chunk = rows.slice(i, i + 1000).map((r) => ({ ...r, updated_at: new Date().toISOString() }));
  const res = await fetch(LOADER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-rpc-gate-key": GATE_KEY },
    body: JSON.stringify({ rows: chunk }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.ok) upserted += j.upserted;
  else { failed++; console.error(`chunk ${i} FAILED http_${res.status}: ${JSON.stringify(j).slice(0, 200)}`); }
}
console.log(`done. upserted ${upserted} rows, ${failed} failed chunks.`);
if (failed > 0) process.exit(1);
