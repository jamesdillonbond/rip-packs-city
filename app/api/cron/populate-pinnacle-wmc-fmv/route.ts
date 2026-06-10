import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// Hourly Pinnacle wmc FMV populator.
//
// Calls the SECDEF helper populate_pinnacle_wmc_fmv(p_limit). The RPC joins
// wmc.render_id → pinnacle_catalog.render_id (per-render FMV, algo
// render-catalog-2.0) and writes wmc.fmv_usd. (Pre-2026-06 it walked the
// legacy pinnacle_nft_map → pinnacle_editions → pinnacle_fmv_snapshots chain;
// that set-level table is retired in favor of the per-render catalog.)
//
// Bearer auth on INGEST_SECRET_TOKEN. Trevor schedules at cron-job.org hourly.
//
// 2026-06-10 (DBSAT residual fix): the RPC ran synchronously and tripped
// cron-job.org's 30s client cap ("Failed (timeout)") every tick under
// saturation. Auth now stays sync, we return 202 immediately, and the RPC +
// log_pipeline_run run in after() (which fires on BOTH the ok and error
// paths). maxDuration raised so the RPC has room past the 30s cron window.

export const maxDuration = 300
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "populate-pinnacle-wmc-fmv"
const LIMIT_PER_RUN = 10000

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  if (!TOKEN || bearer !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  after(async () => {
    let ok = true
    let errMsg: string | null = null
    let examined = 0
    let updated = 0

    try {
      const { data, error } = await (supabaseAdmin as any).rpc(
        "populate_pinnacle_wmc_fmv",
        { p_limit: LIMIT_PER_RUN }
      )
      if (error) {
        ok = false
        errMsg = error.message
      } else {
        examined = Number((data as any)?.examined ?? 0) || 0
        updated = Number((data as any)?.updated ?? 0) || 0
      }
    } catch (e) {
      ok = false
      errMsg = e instanceof Error ? e.message : String(e)
    }

    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAtIso,
        p_rows_found: examined,
        p_rows_written: updated,
        p_rows_skipped: Math.max(0, examined - updated),
        p_ok: ok,
        p_error: errMsg,
        p_collection_slug: "disney_pinnacle",
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: { duration_ms: Date.now() - started, limit: LIMIT_PER_RUN },
      })
    } catch (e) {
      console.log(
        `[populate-pinnacle-wmc-fmv] log_pipeline_run err: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  })

  return NextResponse.json(
    { accepted: true, pipeline: PIPELINE_NAME, started_at: startedAtIso },
    { status: 202 }
  )
}
