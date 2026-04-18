import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── classify-acquisitions cron endpoint ─────────────────────────────────────
//
// Thin wrapper around the Supabase edge function `classify-acquisitions`.
// cron-job.org hits this route on a schedule; we invoke the edge function and
// log the outcome to pipeline_runs via log_pipeline_run.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 60
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "classify-acquisitions"

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  if (!TOKEN || bearer !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()

  let ok = true
  let errMsg: string | null = null
  let result: unknown = null

  try {
    const { data, error } = await supabaseAdmin.functions.invoke(
      "classify-acquisitions",
      { body: {} }
    )
    if (error) {
      ok = false
      errMsg = error.message ?? String(error)
    } else {
      result = data
    }
  } catch (e) {
    ok = false
    errMsg = e instanceof Error ? e.message : String(e)
  }

  const rowsFound = Number((result as any)?.scanned ?? (result as any)?.rows_found ?? 0) || 0
  const rowsWritten = Number((result as any)?.classified ?? (result as any)?.rows_written ?? 0) || 0
  const rowsSkipped = Number((result as any)?.skipped ?? (result as any)?.rows_skipped ?? 0) || 0

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: rowsFound,
      p_rows_written: rowsWritten,
      p_rows_skipped: rowsSkipped,
      p_ok: ok,
      p_error: errMsg,
      p_collection_slug: null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { edge_function_result: result },
    })
  } catch (e) {
    console.log(
      `[classify-acquisitions] log_pipeline_run err: ${
        e instanceof Error ? e.message : String(e)
      }`
    )
  }

  if (!ok) {
    return NextResponse.json(
      { ok: false, error: errMsg ?? "edge function invoke failed" },
      { status: 500 }
    )
  }

  return NextResponse.json({ ok: true, result })
}
