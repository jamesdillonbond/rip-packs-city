// app/api/cron/run-insider-detectors/route.ts
//
// Hourly insider-signal detector cron. Calls run_all_insider_detectors against
// nba_top_shot, nfl_all_day, ufc_strike. The RPC fans out to the three
// individual detectors (unusual edition volume, floor drops, concentration
// buys) and writes rows to topshot_insider_alerts.
//
// Bearer auth on INGEST_SECRET_TOKEN. Trevor schedules at cron-job.org hourly.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "run-insider-detectors"
const COLLECTIONS = ["nba_top_shot", "nfl_all_day", "ufc_strike"]

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  if (!TOKEN || bearer !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  let ok = true
  let errMsg: string | null = null
  let result: unknown = null

  try {
    const { data, error } = await (supabaseAdmin as any).rpc(
      "run_all_insider_detectors",
      { p_collection_slugs: COLLECTIONS }
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

  const written = Number((result as any)?.inserted ?? (result as any)?.rows_written ?? 0) || 0

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: written,
      p_rows_written: written,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: errMsg,
      p_collection_slug: null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { duration_ms: Date.now() - started, collections: COLLECTIONS, detector_result: result },
    })
  } catch (e) {
    console.log(
      `[run-insider-detectors] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`
    )
  }

  return NextResponse.json({ ok, error: errMsg, rows_written: written, result })
}
