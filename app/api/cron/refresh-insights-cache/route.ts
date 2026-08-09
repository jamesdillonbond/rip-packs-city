// app/api/cron/refresh-insights-cache/route.ts
//
// PUBLIC-BOARD-CACHING (nc1, 2026-08-09) — the single WRITER of public_board_snapshots.
//
// Runs each hot public /insights board's heavy default query in the background and
// upserts the JSON payload into the snapshot cache, so the ISR pages + API routes can
// serve it from a tiny PK-keyed row instead of re-running the multi-GB view query on
// every render. Moving the heavy query here means it never runs on a user-facing
// render during disk-IO saturation (the documented failure where a revalidation
// times out and caches an empty board).
//
// Auth: Bearer INGEST_SECRET_TOKEN (same as the other cron routes). Each board is
// warmed independently and best-effort — one board failing never blocks the others,
// and a failed warm just leaves the last-good snapshot in place (readBoardOrLive
// serves it stale). Logs one pipeline_runs row for monitoring.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { WARM_BOARDS, warmBoard, type BoardCacheKey } from "@/lib/insights/board-cache"
import {
  fetchDealsDefault,
  fetchRookiesDefault,
  fetchFirstMintDefault,
} from "@/lib/insights/boards"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const PIPELINE_NAME = "refresh-insights-cache"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BUILDERS: Record<BoardCacheKey, () => Promise<any>> = {
  deals: () => fetchDealsDefault(),
  rookies: () => fetchRookiesDefault(),
  "first-mint": () => fetchFirstMintDefault(),
}

async function run(request: NextRequest) {
  const auth = request.headers.get("authorization")
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  // Warm every board in parallel so one slow view can't serialize the others; each
  // warmBoard is self-contained and never throws.
  const results = await Promise.all(
    WARM_BOARDS.map(({ key }) => warmBoard(key, BUILDERS[key]))
  )

  const okCount = results.filter((r) => r.ok).length
  const rowsWritten = results.reduce((n, r) => n + (r.ok ? 1 : 0), 0)
  const allOk = okCount === results.length

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: results.length,
      p_rows_written: rowsWritten,
      p_rows_skipped: results.length - rowsWritten,
      p_ok: allOk,
      p_error: allOk
        ? null
        : results
            .filter((r) => !r.ok)
            .map((r) => `${r.key}${r.error ? `: ${r.error}` : ""}`)
            .join("; "),
      p_extra: {
        duration_ms: Date.now() - startedMs,
        boards: results.map((r) => ({ key: r.key, ok: r.ok, row_count: r.rowCount })),
      },
    })
  } catch (logErr) {
    console.log(
      `[${PIPELINE_NAME}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`
    )
  }

  return NextResponse.json({
    ok: allOk,
    pipeline: PIPELINE_NAME,
    warmed: okCount,
    total: results.length,
    boards: results,
  })
}

export async function POST(request: NextRequest) {
  return run(request)
}

export async function GET(request: NextRequest) {
  return run(request)
}
