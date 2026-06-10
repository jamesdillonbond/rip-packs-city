import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as any,
  process.env.SUPABASE_SERVICE_ROLE_KEY as any,
)

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Weekly DB maintenance, folded in 2026-06-10. The cron-job.org entry "RPC
// Pipeline Runs Cleanup" called /rest/v1/rpc/run_weekly_db_maintenance directly
// with the anon key, but the fn is deliberately service_role-only, so it failed
// every Saturday. This leg runs the same maintenance from a service-role client
// gated on a 6-day dedupe window (not day-of-week), so a missed run self-heals
// on the next daily prune tick. Runs inside after() (CRON-30S pattern) so the
// daily prune response stays sync. Do NOT widen run_weekly_db_maintenance grants.
async function runWeeklyMaintenanceIfDue() {
  const startedAt = new Date().toISOString()
  try {
    const sixDaysAgo = new Date(
      Date.now() - 6 * 24 * 60 * 60 * 1000,
    ).toISOString()
    const { data: recent, error: checkError } = await supabaseAdmin
      .from("pipeline_runs")
      .select("started_at")
      .eq("pipeline", "weekly-db-maintenance")
      .eq("ok", true)
      .gte("started_at", sixDaysAgo)
      .limit(1)
    if (checkError) {
      console.error(
        "[prune-logs] weekly-maintenance gate check failed:",
        checkError.message,
      )
      return
    }
    if (recent && recent.length > 0) {
      // A successful weekly run already landed inside the window — nothing due.
      return
    }

    const { data, error } = await supabaseAdmin.rpc("run_weekly_db_maintenance")
    if (error) {
      console.error(
        "[prune-logs] run_weekly_db_maintenance failed:",
        error.message,
      )
    }
    await supabaseAdmin.rpc("log_pipeline_run", {
      p_pipeline: "weekly-db-maintenance",
      p_started_at: startedAt,
      p_ok: !error,
      p_error: error ? error.message : null,
      p_extra: error ? null : (data ?? null),
    })
  } catch (err: any) {
    console.error(
      "[prune-logs] weekly-maintenance leg unhandled:",
      err?.message,
    )
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: "weekly-db-maintenance",
        p_started_at: startedAt,
        p_ok: false,
        p_error: err?.message ?? "unknown",
      })
    } catch {}
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Self-healing weekly DB maintenance leg (gated; usually a no-op). Scheduled
  // before the prune so it runs even if prune throws.
  after(() => runWeeklyMaintenanceIfDue())

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
