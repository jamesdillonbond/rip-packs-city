import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as any,
  process.env.SUPABASE_SERVICE_ROLE_KEY as any,
)

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Weekly DB maintenance moved to pg_cron 2026-07-18. It used to run here inside
// after() (gated 6-day dedupe), but run_weekly_db_maintenance was one txn (fast
// log purges + a per-wallet wmc stale-prune) self-capped at 120s; under IOPS
// contention the wmc leg rolled the whole txn back and nothing got pruned. It is
// now split into two independently-committing pg_cron jobs on 600s budgets:
//   rpc-weekly-log-purges  (daily 09:40Z) -> run_weekly_log_purges()  [heartbeat]
//   rpc-weekly-wmc-prune   (Sun  10:20Z)  -> prune_stale_wmc()
// so this route only owns the daily prune_log_tables leg below.

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = new Date().toISOString()

  try {
    const rpcResult = await supabaseAdmin.rpc("prune_log_tables")

    if (rpcResult.error) {
      console.error("[prune-logs] RPC error:", rpcResult.error)
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: "prune-log-tables",
        p_started_at: startedAt,
        p_ok: false,
        p_error: rpcResult.error.message,
        p_extra: null,
      })
      return NextResponse.json(
        { status: "error", error: rpcResult.error.message },
        { status: 500 },
      )
    }

    const summary = rpcResult.data as {
      pipeline_runs_deleted: number
      listing_resolution_failures_deleted: number
      smoke_test_results_deleted: number
    }

    const totalDeleted =
      (summary.pipeline_runs_deleted ?? 0) +
      (summary.listing_resolution_failures_deleted ?? 0) +
      (summary.smoke_test_results_deleted ?? 0)

    await supabaseAdmin.rpc("log_pipeline_run", {
      p_pipeline: "prune-log-tables",
      p_started_at: startedAt,
      p_rows_written: totalDeleted,
      p_ok: true,
      p_extra: summary,
    })

    return NextResponse.json({
      ...summary,
      status: "ok",
      total_deleted: totalDeleted,
    })
  } catch (err: any) {
    console.error("[prune-logs] Unhandled error:", err.message)
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: "prune-log-tables",
        p_started_at: startedAt,
        p_ok: false,
        p_error: err.message,
      })
    } catch {}
    return NextResponse.json(
      { status: "error", error: err.message },
      { status: 500 },
    )
  }
}
