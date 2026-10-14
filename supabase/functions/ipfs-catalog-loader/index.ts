// supabase/functions/ipfs-catalog-loader/index.ts (v4)
//
// Batch-ingest endpoint for public.topshot_ipfs_assets.
// v2 -> v3: allow per-asset pin-size columns (audit_20260610_topshot_ipfs_assets_pin_sizes).
//
// The caller (scripts/refresh-ipfs-catalog.mjs) extracts/groups the Dapper reference-app
// dataset (see docs/handoff-2026-06-09-ipfs-verified-media.md for the recipe) and POSTs
// {rows:[...]} in chunks; this fn upserts via service_role.
// Upsert key: (play_flow_id, set_uuid, parallel).
//
// ── v4 (2026-10-14, register R21 (c)) ───────────────────────────────────────
// Source RECOVERED from deployed v35 (it had no committed source) by a redacted subagent.
// The v3 gate was a 48-char literal `LOADER_TOKEN` compared by SUBSTRING (`auth.includes(...)`,
// so any header CONTAINING it passed) or via `?token=` (logged in full by the edge runtime), and
// the operator script told you to copy that literal out of the deployed source — the leak path.
// Now: ../_shared/cron-gate.ts, the same Vault gate the pg_cron lanes use, under its own secret
// `cron_gate_key__ipfs-catalog-loader` (created in SQL by migration 20261014155620_audit_20261014_r21_ipfs_loader_vault_gate,
// never read out). The operator script fetches it at run time through `cron_gate_key()` with the
// service-role key it already needs, and sends it in the `x-rpc-gate-key` header. Nobody copies it.
// Also: a batch whose rows ALL fail the shape filter is a 400, not `ok:true, upserted:0`.

import { createClient } from "@supabase/supabase-js";
import { cronGate } from "../_shared/cron-gate.ts";

const MAX_ROWS = 2000;
const JSON_HEADERS = { "Content-Type": "application/json" };

const ALLOWED_KEYS = new Set([
  "play_flow_id", "set_flow_id", "play_uuid", "set_uuid", "set_name",
  "rarity", "series", "parallel", "player_name",
  "video_cid", "video_square_cid", "video_tall_cid", "video_vertical_cid",
  "hero_cid", "player_cid", "image_player_cid",
  "video_pin_size", "video_square_pin_size", "video_tall_pin_size", "video_vertical_pin_size",
  "hero_pin_size", "player_pin_size", "image_player_pin_size",
  "updated_at",
]);

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

Deno.serve(async (req: Request) => {
  const gateDenied = await cronGate(req, supabase, "ipfs-catalog-loader");
  if (gateDenied) return gateDenied;
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: JSON_HEADERS });
  }

  let body: { rows?: Record<string, unknown>[] } = {};
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400, headers: JSON_HEADERS });
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0 || rows.length > MAX_ROWS) {
    return new Response(JSON.stringify({ error: `rows must be 1..${MAX_ROWS}` }), { status: 400, headers: JSON_HEADERS });
  }

  const clean: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (r == null || typeof r !== "object") continue;
    if (r["play_flow_id"] == null || r["set_uuid"] == null) continue;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) if (ALLOWED_KEYS.has(k)) o[k] = v;
    if (o["parallel"] == null) o["parallel"] = "Base";
    clean.push(o);
  }
  if (clean.length === 0) {
    return new Response(
      JSON.stringify({ error: "no row carried play_flow_id and set_uuid", skipped: rows.length }),
      { status: 400, headers: JSON_HEADERS },
    );
  }

  const { error } = await supabase
    .from("topshot_ipfs_assets")
    .upsert(clean, { onConflict: "play_flow_id,set_uuid,parallel" });

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message.slice(0, 300) }), { status: 500, headers: JSON_HEADERS });
  }
  // `upserted` = rows SENT in an upsert the database accepted without error.
  return new Response(JSON.stringify({ ok: true, upserted: clean.length, skipped: rows.length - clean.length }), { status: 200, headers: JSON_HEADERS });
});
