import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as any,
  process.env.SUPABASE_SERVICE_ROLE_KEY as any,
)

export const dynamic = "force-dynamic"
export const maxDuration = 60

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
