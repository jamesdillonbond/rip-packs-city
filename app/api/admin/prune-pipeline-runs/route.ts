import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// POST /api/admin/prune-pipeline-runs — Authorization: Bearer $INGEST_SECRET_TOKEN
//
// Daily cron-job.org schedule: prunes pipeline_runs rows older than 7 days.
// Calls public.prune_pipeline_runs(p_retention_days int) RPC, which returns a
// JSONB summary { deleted: int, ... }. Fire-and-forget via after() so the cron
// caller gets an immediate 200 instead of waiting on the DELETE.
//
// Note: the RPC signature is p_retention_days (not p_keep_days as the spec
// suggested) — verified against pg_proc on 2026-05-03.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const KEEP_DAYS = 7

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  if (!TOKEN || req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = Date.now()

  after(async () => {
    try {
      const { data, error } = await supabaseAdmin.rpc("prune_pipeline_runs", {
        p_retention_days: KEEP_DAYS,
      })
      const durationMs = Date.now() - startedAt
      if (error) {
        console.log(`[prune-pipeline-runs] rpc error: ${error.message} (duration_ms=${durationMs})`)
      } else {
        console.log(`[prune-pipeline-runs] ok keep_days=${KEEP_DAYS} duration_ms=${durationMs} result=${JSON.stringify(data)}`)
      }
    } catch (err) {
      console.log(`[prune-pipeline-runs] fatal: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  return NextResponse.json({
    ok: true,
    queued: true,
    keep_days: KEEP_DAYS,
    note: "Prune queued; result logged to Vercel runtime logs.",
  })
}
