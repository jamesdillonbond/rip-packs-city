import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// Multi-collection acquisitions classification cron.
//
// NBA Top Shot already has its own classify_acquisition path. This route
// handles AllDay / Golazos / UFC by calling the SECDEF helper
// backfill_acquisitions_for_collection(uuid, limit) once per collection.
// Pinnacle uses pinnacle_sales (separate schema) and is excluded.
//
// Bearer auth on INGEST_SECRET_TOKEN. Schedule from cron-job.org hourly.

export const maxDuration = 120
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "classify-acquisitions-multicollection"

const PER_COLLECTION_LIMIT = 500

const TARGETS: Array<{ slug: string; collection_id: string; limit?: number }> = [
  // AllDay capped at 80/tick (measured 2026-07-01): the candidate scan is a deep
  // Merge-Anti-Join over the full AllDay sales history probing the sparse wmc cache,
  // so cost scales ~linearly with the batch (150 rows = ~67s, 80 = ~36s). 300 ran past
  // the fn's 90s statement_timeout under load (~40% flap); 80 completes with ~2.5x
  // headroom and keeps the 3-collection after() loop under the 120s maxDuration.
  { slug: "nfl_all_day",      collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070", limit: 80 },
  { slug: "laliga_golazos",   collection_id: "06248cc4-b85f-47cd-af67-1855d14acd75" },
  { slug: "ufc_strike",       collection_id: "9b4824a8-736d-4a96-b450-8dcc0c46b023" },
]

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  if (!TOKEN || bearer !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()

  // 202 + after(): the 3-collection classify loop (maxDuration=120) can exceed
  // cron-job.org's 30s client cap under DB saturation; auth stays sync, the
  // loop + log_pipeline_run move into after(), and we return immediately so the
  // entry can never be auto-disabled. pipeline_runs is the real success signal.
  after(async () => {
    const perCollection: Record<string, unknown> = {}
    let totalFound = 0
    let totalWritten = 0
    let totalSkipped = 0
    let firstError: string | null = null

    for (const t of TARGETS) {
      try {
        const { data, error } = await (supabaseAdmin as any).rpc(
          "backfill_acquisitions_for_collection",
          { p_collection_id: t.collection_id, p_limit: t.limit ?? PER_COLLECTION_LIMIT }
        )
        if (error) {
          firstError = firstError ?? `${t.slug}: ${error.message}`
          perCollection[t.slug] = { ok: false, error: error.message }
          continue
        }
        const found = Number((data as any)?.scanned ?? (data as any)?.rows_found ?? 0) || 0
        const written = Number((data as any)?.classified ?? (data as any)?.inserted ?? (data as any)?.rows_written ?? 0) || 0
        const skipped = Number((data as any)?.skipped ?? (data as any)?.rows_skipped ?? 0) || 0
        totalFound += found
        totalWritten += written
        totalSkipped += skipped
        perCollection[t.slug] = { ok: true, found, written, skipped, raw: data }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        firstError = firstError ?? `${t.slug}: ${msg}`
        perCollection[t.slug] = { ok: false, error: msg }
      }
    }

    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAtIso,
        p_rows_found: totalFound,
        p_rows_written: totalWritten,
        p_rows_skipped: totalSkipped,
        p_ok: !firstError,
        p_error: firstError,
        p_collection_slug: null,
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: { per_collection: perCollection },
      })
    } catch (e) {
      console.log(
        `[classify-acquisitions-multicollection] log_pipeline_run err: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  })

  return NextResponse.json(
    { ok: true, accepted: true, pipeline: PIPELINE_NAME },
    { status: 202 }
  )
}
