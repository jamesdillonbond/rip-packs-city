// app/api/cron/panini-fmv-recalc/route.ts
//
// Panini Blockchain — FMV recompute cron. Writes panini_fmv_snapshots (algo
// 'panini-1.0.0') per edition, serial-aware where the feed exposes per-serial
// asks/sales. Own table per the Pinnacle precedent — kept out of the uuid-keyed
// fmv_snapshots partition set.
//
// INERT until go-live: short-circuits to a logged no-op until PANINI_FEED_MODE +
// creds are set AND the panini_fmv_snapshots table is applied
// (docs/drafts/panini/panini-schema.sql). The FMV algorithm + sales basis are
// specified at go-live once the Plane-A sales/ask feed shape is known (and,
// later, the Plane-B bridge secondary-sales source). Do NOT wire a cron entry /
// watchlist row until one manual run produces sane confidences.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { paniniFeedEnabled, paniniFeedMode } from "@/lib/chains/panini/feed"
import { PANINI_SLUG } from "@/lib/chains/panini/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "panini-fmv-recalc"

function authed(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization") ?? ""
  const ingest = process.env.INGEST_SECRET_TOKEN
  const cron = process.env.CRON_SECRET
  return (
    (!!ingest && authHeader === `Bearer ${ingest}`) ||
    (!!cron && authHeader === `Bearer ${cron}`)
  )
}

async function logRun(
  startedAtIso: string,
  rowsFound: number,
  rowsWritten: number,
  ok: boolean,
  error: string | null,
  extra: Record<string, unknown>
) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: rowsFound,
      p_rows_written: rowsWritten,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: error,
      p_collection_slug: PANINI_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: extra,
    })
  } catch (e) {
    console.log(
      `[${PIPELINE_NAME}] log_pipeline_run failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

export async function POST(req: NextRequest) {
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()

  // Two inert gates: the feed must be live AND the FMV algo must be wired. Until
  // both, log an honest skip rather than write empty/garbage snapshots.
  if (!paniniFeedEnabled()) {
    await logRun(startedAtIso, 0, 0, true, null, { skip_reason: "feed_inert", mode: paniniFeedMode() })
    return NextResponse.json(
      { accepted: false, skipped: "feed_inert", collection: PANINI_SLUG },
      { status: 202 }
    )
  }

  after(async () => {
    // TODO(go-live): compute FMV per panini_editions row from the Plane-A
    // sales/ask basis (and Plane-B bridge sales once bridgeable), then
    // delete-then-insert one panini_fmv_snapshots row per edition tagged
    // 'panini-1.0.0' with HIGH/MEDIUM/LOW/ASK_ONLY/SALES_ONLY/STALE/NO_DATA
    // confidence (reuse lib/fmv-confidence.ts), plus an optional serial_fmv
    // payload. Until the algo lands this is a logged no-op.
    await logRun(startedAtIso, 0, 0, true, null, {
      skip_reason: "fmv_algo_pending",
      note: "panini-1.0.0 FMV compute specified at go-live (sales/ask basis TBD)",
      mode: paniniFeedMode(),
    })
  })

  return NextResponse.json(
    { accepted: true, collection: PANINI_SLUG, started_at: startedAtIso, note: "fmv_algo_pending" },
    { status: 202 }
  )
}
