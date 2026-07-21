// ingest-topshot-atlas-pool v5 (2026-07-17) - receiving side of the Atlas real-remaining
// harvest. v5 fixes the failure-classification bug from the 07-17 harvest: Atlas returns a
// VALID-BUT-EMPTY envelope ({editions:[], totalCount}) for bundle (Box/Case) distributions
// on both id forms, and for the numeric dist_id form of dists whose pack_listing_uuid form
// succeeds. v4 logged those as ok=false 'unmapped_shape' pipeline failures (177 rows,
// tripped the failure alert). v5 classifies an empty envelope as 'atlas_empty': logged
// ok=true, recorded in topshot_atlas_no_pool_dists (which v_topshot_atlas_pool_targets
// excludes for 30d), and the marker is deleted when a later id-form/harvest succeeds.
// Genuinely unrecognized shapes still log ok=false 'unmapped_shape'.
// Confirmed Atlas GetDistributionEditions shape (primary map):
//   element = { editionId, originalCount, remainingCount, edition:{ setId, editionTemplateId, ... } }
//   -> external_id = `${edition.setId}:${editionTemplateId}` (verified: 139:4956 maps 1:1 to
//   our editions.external_id / set_id_onchain:play_id_onchain). Legacy candidate keys kept as
//   fallbacks. CORS + OPTIONS retained so the operator runs it from the nbatopshot.com console
//   (TS session JWT stays in the browser). Writes go through SECDEF upsert_topshot_atlas_pool
//   (pool_source='atlas'). Atlas ERROR responses ({code,message}) are recognized + skipped.
import { createClient } from "jsr:@supabase/supabase-js@2"

// Ingest gate key is a Supabase edge SECRET, never hardcoded (this repo is public).
// Fail CLOSED if the secret is unset — see the check at the request handler below.
// Rotate with: supabase secrets set ATLAS_POOL_INGEST_KEY=<new-random>
const KEY = Deno.env.get("ATLAS_POOL_INGEST_KEY") ?? ""
const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } })
}

async function log(ok: boolean, extra: Record<string, unknown>) {
  try {
    await supabase.rpc("log_pipeline_run", {
      p_pipeline: "topshot-atlas-pool-ingest", p_started_at: new Date().toISOString(),
      p_rows_found: 0, p_rows_written: Number(extra.rows ?? 0), p_rows_skipped: 0, p_ok: ok, p_error: ok ? null : String(extra.reason ?? "error"),
      p_collection_slug: "nba-top-shot", p_cursor_before: null, p_cursor_after: null, p_extra: extra,
    })
  } catch { /* ignore */ }
}

// deno-lint-ignore no-explicit-any
function num(v: any): number | null {
  if (v == null || v === false) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

type NormResult = {
  kind: "ok" | "empty" | "unmapped"
  rows: Array<{ set: number; play: number; remaining: number; original: number }> | null
  sampleKeys: string[]
  totalCount: number | null
}

// Normalize a raw Atlas GetDistributionEditions response into canonical rows.
// Primary (confirmed) shape: { editions:[ { editionId, originalCount, remainingCount,
//   edition:{ setId, editionTemplateId } } ], totalCount }. Fallback candidate keys kept.
// kind 'empty' = well-formed envelope with an empty editions array (Atlas has no pool
// data for this id — normal for bundle box/case dists and for the wrong id form).
// kind 'unmapped' = shape we genuinely don't recognize (caller rejects + logs keys).
// deno-lint-ignore no-explicit-any
function normalizeAtlas(raw: any): NormResult {
  const totalCount = num(raw?.totalCount) ?? num(raw?.data?.totalCount)
  const arr = raw?.editions ?? raw?.data?.editions ?? (Array.isArray(raw) ? raw : null)
  if (Array.isArray(arr) && arr.length === 0) {
    return { kind: "empty", rows: null, sampleKeys: raw ? Object.keys(raw) : [], totalCount }
  }
  if (!Array.isArray(arr)) {
    return { kind: "unmapped", rows: null, sampleKeys: raw ? Object.keys(raw) : [], totalCount }
  }
  const sampleKeys = Object.keys(arr[0] ?? {})
  const rows: Array<{ set: number; play: number; remaining: number; original: number }> = []
  for (const e of arr) {
    if (!e) continue
    const ed = e.edition ?? {}
    // Confirmed Atlas fields first, then legacy fallbacks.
    const set = num(ed.setId) ?? num(e.setFlowId) ?? num(e.set_flow_id) ?? num(e.setId) ?? num(e.set?.flowId)
    const play = num(ed.editionTemplateId) ?? num(e.playFlowId) ?? num(e.play_flow_id) ?? num(e.playId) ?? num(e.play?.flowID)
    const remaining = num(e.remainingCount) ?? num(e.remaining_count) ?? num(e.remaining)
    const original = num(e.originalCount) ?? num(e.original_count) ?? num(e.original) ?? 0
    if (set == null || play == null || remaining == null) continue
    rows.push({ set, play, remaining, original: original ?? 0 })
  }
  if (rows.length === 0) return { kind: "unmapped", rows: null, sampleKeys, totalCount }
  return { kind: "ok", rows, sampleKeys, totalCount }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  const url = new URL(req.url)
  if (!KEY || url.searchParams.get("key") !== KEY) return json({ ok: false, reason: "unauthorized" }, 401)

  if (req.method === "GET" && url.searchParams.get("mode") === "targets") {
    const { data, error } = await supabase.from("v_topshot_atlas_pool_targets")
      .select("dist_id, pack_listing_uuid, title, reason").limit(500)
    if (error) return json({ ok: false, error: error.message }, 500)
    return json({ ok: true, targets: data })
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => null)
    if (!body || !body.dist_id) return json({ ok: false, reason: "bad_body" }, 400)
    const distId = String(body.dist_id)
    // Atlas error envelope: {code, message} - skip cleanly (usually the wrong id form).
    if (body.atlas && body.atlas.code && body.atlas.message && !body.atlas.editions) {
      return json({ ok: false, reason: "atlas_error", atlas_code: body.atlas.code })
    }
    let editions = Array.isArray(body.editions) ? body.editions : null
    let usedKeys: string[] = []
    if (!editions && body.atlas) {
      const norm = normalizeAtlas(body.atlas)
      usedKeys = norm.sampleKeys
      if (norm.kind === "empty") {
        // Honest Atlas answer, not a pipeline failure: no pool data exists for this id
        // (bundle box/case dists, or the wrong of the two id forms the harvester tries).
        // Record the marker so the targets view stops re-serving the dist; a later
        // successful harvest (e.g. the other id form) deletes it below.
        await supabase.from("topshot_atlas_no_pool_dists").upsert(
          { dist_id: distId, last_checked_at: new Date().toISOString(), total_count: norm.totalCount },
          { onConflict: "dist_id" },
        )
        await log(true, { dist_id: distId, reason: "atlas_empty", total_count: norm.totalCount })
        return json({ ok: false, reason: "atlas_empty", total_count: norm.totalCount })
      }
      if (norm.kind === "unmapped") {
        await log(false, { dist_id: distId, reason: "unmapped_shape", sample_keys: norm.sampleKeys, total_count: norm.totalCount })
        return json({ ok: false, reason: "unmapped_shape", sample_keys: norm.sampleKeys }, 422)
      }
      editions = norm.rows
    }
    if (!editions) return json({ ok: false, reason: "no_editions" }, 400)

    const { data, error } = await supabase.rpc("upsert_topshot_atlas_pool", {
      p_dist_id: distId, p_editions: editions,
    })
    if (error) {
      await log(false, { dist_id: distId, reason: error.message })
      return json({ ok: false, error: error.message }, 500)
    }
    const upsertOk = (data as { ok?: boolean })?.ok === true
    if (upsertOk) {
      // A real pool landed — any stale no-data marker (e.g. from the other id form) is wrong now.
      await supabase.from("topshot_atlas_no_pool_dists").delete().eq("dist_id", distId)
    }
    await log(upsertOk, { dist_id: distId, sample_keys: usedKeys, ...(data as Record<string, unknown>) })
    return json(data)
  }

  return json({ ok: false, reason: "method_not_allowed" }, 405)
})
