import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// Explicit Vercel Function budget (GHA-triggered; some use after() fire-and-forget).
export const maxDuration = 120;

// Daily 48h purge of `cached_listings` (the legacy listing cache — distinct from
// `cached_listings_v2`, which this does NOT touch).
//
// This ran every day at 04:00 UTC with ZERO observability until 2026-08-01: it
// never called log_pipeline_run, so nothing recorded how many rows it removed and
// a silent failure (or a predicate quietly matching everything) would have been
// invisible. `pipeline_runs` had no row for it, ever. Instrumented below; the
// DELETE predicate is deliberately UNCHANGED in that commit — measure first, then
// decide whether 48h is still the right cutoff.
//
// Scale at instrumentation time: 306 rows total, 1 older than 48h, table actively
// written (max cached_at = same day). So this is a small, healthy job.
//
// ⚠ `deletedCount` is derived from the RETURNING representation, which PostgREST
// CAPS AT 1000. The DELETE itself is unbounded, so the rows really do go; only the
// reported number saturates. It is logged as rows_written with a `count_capped`
// flag so a future reader can never mistake a saturated 1000 for the true total.
async function purgeStaleListings(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()

  async function logRun(args: {
    ok: boolean
    rowsWritten: number
    errorMsg: string | null
    extra: Record<string, unknown>
  }) {
    try {
      const { error } = await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: "purge-stale-listings",
        p_started_at: startedAtIso,
        p_rows_found: args.rowsWritten,
        p_rows_written: args.rowsWritten,
        p_rows_skipped: 0,
        p_ok: args.ok,
        p_error: args.errorMsg,
        p_collection_slug: null,
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: args.extra,
      })
      if (error) console.log("[purge-stale-listings] log_pipeline_run:", error.message)
    } catch (err) {
      console.log("[purge-stale-listings] log_pipeline_run threw:", err instanceof Error ? err.message : err)
    }
  }

  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

    const { data, error } = await supabaseAdmin
      .from("cached_listings")
      .delete()
      .lt("cached_at", cutoff)
      .select("id")

    if (error) {
      console.error("[purge-stale-listings] Delete error:", error.message)
      await logRun({ ok: false, rowsWritten: 0, errorMsg: error.message, extra: { cutoff } })
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }

    const deletedCount = data?.length ?? 0
    console.log(`[purge-stale-listings] Purged ${deletedCount} stale listings older than 48h`)
    await logRun({
      ok: true,
      rowsWritten: deletedCount,
      errorMsg: null,
      extra: { cutoff, count_capped: deletedCount >= 1000 },
    })

    return NextResponse.json({ ok: true, deletedCount })
  } catch (e) {
    console.error("[purge-stale-listings] Fatal error:", e)
    const msg = e instanceof Error ? e.message : "Purge failed"
    await logRun({ ok: false, rowsWritten: 0, errorMsg: msg, extra: {} })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return purgeStaleListings(req)
}

export async function POST(req: NextRequest) {
  return purgeStaleListings(req)
}
