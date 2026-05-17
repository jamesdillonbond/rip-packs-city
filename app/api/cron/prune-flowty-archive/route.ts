// app/api/cron/prune-flowty-archive/route.ts
//
// Nightly retention prune for flowty_archive.api_harvest_20260512.
//
// As of 2026-05-17 the table is 9.35 GB / 74,562 rows / 85% of the entire
// rip-packs-city Supabase database, growing at ~600 rows/hr (~50 MB/hr).
// The single referencing function (flowty_archive_insert_batch) is the
// writer; nothing reads from it. PRO Micro storage ceiling will be hit
// within days without retention.
//
// Calls prune_flowty_archive_api_harvest(7, 10000) — 7-day retention,
// 10,000 rows per batch, 20 batches max per invocation (so a single
// nightly run drops up to 200,000 rows). Schedule cron-job.org at
// 04:15 UTC daily. Bearer INGEST_SECRET_TOKEN or ?token=.
//
// One-shot reclaim of the existing ~9 GB backlog (TRUNCATE-style) is
// intentionally NOT in this route — the user wants explicit confirmation
// before that lever is pulled. Until then, the nightly prune steadily
// drains rows older than the retention threshold; one-shot reclaim can
// run as a separate ad-hoc operation if/when greenlit.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "prune-flowty-archive-api-harvest"

function authorized(req: NextRequest): boolean {
  const expected = process.env.INGEST_SECRET_TOKEN
  const cronSecret = process.env.CRON_SECRET
  if (!expected) return false
  const bearer = req.headers.get("authorization") ?? ""
  if (bearer.startsWith("Bearer ")) {
    const tok = bearer.slice(7)
    if (tok === expected) return true
    if (cronSecret && tok === cronSecret) return true
  }
  const qp = req.nextUrl.searchParams.get("token")
  return qp === expected
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const startedAtIso = new Date().toISOString()
  const startedMs = Date.now()

  const retentionDays = Math.max(1, Math.min(90, Number(req.nextUrl.searchParams.get("retention_days") ?? 7)))
  const batchSize = Math.max(100, Math.min(50000, Number(req.nextUrl.searchParams.get("batch_size") ?? 10000)))

  let ok = true
  let errMsg: string | null = null
  let result: any = null

  try {
    const { data, error } = await (supabaseAdmin as any).rpc(
      "prune_flowty_archive_api_harvest",
      { p_retention_days: retentionDays, p_batch_size: batchSize }
    )
    if (error) {
      ok = false
      errMsg = error.message
    } else {
      result = data
    }
  } catch (e) {
    ok = false
    errMsg = e instanceof Error ? e.message : String(e)
  }

  const rowsDeleted = Number(result?.rows_deleted ?? 0)

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: rowsDeleted,
      p_rows_written: rowsDeleted,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: errMsg,
      p_collection_slug: null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        retention_days: retentionDays,
        batch_size: batchSize,
        batches_run: result?.batches_run,
        oldest_survivor: result?.oldest_survivor,
        newest_survivor: result?.newest_survivor,
        duration_ms: Date.now() - startedMs,
      },
    })
  } catch (e) {
    console.log(
      `[${PIPELINE_NAME}] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  return NextResponse.json({ ok, error: errMsg, ...result })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
