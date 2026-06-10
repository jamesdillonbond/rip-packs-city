// app/api/cron/backfill-pack-pull-source-rip-id/route.ts
//
// Drains the 6925-row gap (2026-05-17) of moment_acquisitions rows where
// acquisition_method='pack_pull' AND source_pack_rip_id IS NULL by joining
// (wallet=opener_address, acquired_date BETWEEN sealed_at - 5min AND
// sealed_at + 30min) to pack_rips. Schedule cron-job.org at :11 and :41
// (every 30min). Cap=1000/run via backfill_pack_pull_source_rip_id
// (server-side RPC). Drains ~3.5h at 1000/run.
//
// Auth: Bearer INGEST_SECRET_TOKEN (also accepts ?token=). GET/POST.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "pack-pull-source-rip-id-backfill"

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
  const limit = Math.max(1, Math.min(5000, Number(req.nextUrl.searchParams.get("limit") ?? 1000)))

  // 202 + after(): a cap=1000 backfill can exceed cron-job.org's 30s client
  // cap under DB saturation; auth + param parse stay sync, the work + log
  // move into after(), and we return immediately so the entry can never be
  // auto-disabled on a timeout. pipeline_runs is the real success signal.
  after(async () => {
    const startedMs = Date.now()
    let ok = true
    let errMsg: string | null = null
    let result: any = null

    try {
      const { data, error } = await (supabaseAdmin as any).rpc(
        "backfill_pack_pull_source_rip_id",
        { p_limit: limit }
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

    const examined = Number(result?.examined ?? 0)
    const exact = Number(result?.exact_match ?? 0)
    const inferred = Number(result?.inferred ?? 0)
    const noMatch = Number(result?.no_match ?? 0)
    const rowsWritten = exact + inferred

    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAtIso,
        p_rows_found: examined,
        p_rows_written: rowsWritten,
        p_rows_skipped: noMatch,
        p_ok: ok,
        p_error: errMsg,
        p_collection_slug: "nba_top_shot",
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: {
          limit,
          examined,
          exact_match: exact,
          inferred,
          no_match: noMatch,
          duration_ms: Date.now() - startedMs,
        },
      })
    } catch (e) {
      console.log(
        `[${PIPELINE_NAME}] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  })

  return NextResponse.json(
    { ok: true, accepted: true, pipeline: PIPELINE_NAME, limit },
    { status: 202 }
  )
}

export async function GET(req: NextRequest) {
  return POST(req)
}
