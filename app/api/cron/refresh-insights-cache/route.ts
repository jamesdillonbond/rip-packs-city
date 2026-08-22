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
import {
  WARM_BOARDS,
  warmBoard,
  readBoardSnapshotAges,
  stalestBoards,
  BOARD_SNAPSHOT_STALE_CEILING_MS,
  type BoardCacheKey,
} from "@/lib/insights/board-cache"
import {
  fetchDealsDefault,
  fetchRookiesDefault,
  fetchFirstMintDefault,
} from "@/lib/insights/boards"
import { fetchCandyMlbDefault } from "@/lib/insights/candy-board"
import { fetchPaniniSqueezeDefault } from "@/lib/insights/panini-board"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const PIPELINE_NAME = "refresh-insights-cache"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BUILDERS: Record<BoardCacheKey, () => Promise<any>> = {
  deals: () => fetchDealsDefault(),
  rookies: () => fetchRookiesDefault(),
  "first-mint": () => fetchFirstMintDefault(),
  "candy-mlb": () => fetchCandyMlbDefault(),
  "panini-squeeze": () => fetchPaniniSqueezeDefault(),
}

async function run(request: NextRequest) {
  // Vercel cron injects `Authorization: Bearer $CRON_SECRET`; a manual/backstop
  // run uses INGEST_SECRET_TOKEN. Accept EITHER — a route that accepts only the
  // ingest token 401s every Vercel-cron tick (the documented pinnacle-sync footgun).
  const auth = request.headers.get("authorization") ?? ""
  const cronSecret = process.env.CRON_SECRET
  const ingest = process.env.INGEST_SECRET_TOKEN
  const authorized =
    (!!cronSecret && auth === `Bearer ${cronSecret}`) ||
    (!!ingest && auth === `Bearer ${ingest}`)
  if (!authorized) {
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
  const rowsWritten = okCount
  const failed = results.filter((r) => !r.ok)

  // ── Per-tick outcome ──────────────────────────────────────────────────────
  // A single board timing out under disk-IO saturation is EXPECTED (that is the
  // condition this cache exists to survive) — the unwarmed board just serves
  // live/stale, non-regressive. So the run is ok as long as it warmed at least one
  // board; only a total failure (0 warmed) is a real signal. Per-board outcomes go
  // in `extra` so a partial warm is still visible without reading as a red pipeline.
  const warmedSomething = okCount > 0

  // ── Cumulative outcome (2026-08-15) ───────────────────────────────────────
  // ⚠ The per-tick rule above is sound and MEASUREMENT SHOWED IT IS NOT ENOUGH.
  // Over 869 ticks / 3.2 days, `deals` failed 59.5% of ticks and once went 34
  // consecutive ticks (~2h50m) without a refresh — and every one of those runs
  // logged `ok: true`, because `okCount > 0` was satisfied by candy-mlb, which
  // succeeds 95.6% of the time. So the pipeline reported perfect health while the
  // flagship public board served hours-old data. The reasoning was right; its
  // premise (that failures are occasional and rotate) was not.
  //
  // A tick's outcome cannot express that, because the quantity that matters is
  // cumulative: how long has this board actually gone unrefreshed. So read it.
  const ages = await readBoardSnapshotAges()
  const stale = stalestBoards(ages)
  const neverWarmed = ages.filter((a) => a.ageMs == null)

  // ⚠ `ok` now also fails on a board past the 2h ceiling — measured at ~1.2
  // occurrences/day, i.e. rare enough to mean something. NOTE FOR WHOEVER WIRES
  // AN ALARM: nothing currently consumes pipeline_runs.ok for this pipeline
  // (get_pipeline_alerts_core reads silent_indexer_failures + event_cursor;
  // detect_stalled_pipelines watches CADENCE, and the cadence here is perfect —
  // the cron ticks reliably, it is the work inside that fails). So this makes the
  // row honest and greppable; it does not yet page anyone. Adding a
  // pipeline_cadence_watchlist entry would NOT help for the same reason.
  const ok = warmedSomething && stale.length === 0

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: results.length,
      p_rows_written: rowsWritten,
      p_rows_skipped: results.length - rowsWritten,
      p_ok: ok,
      // The staleness verdict leads, because it is the one an operator can act
      // on; the per-tick reasons follow, since a single failed warm is routine.
      p_error:
        stale.length || failed.length
          ? [
              ...stale.map(
                (a) => `STALE ${a.key}: snapshot ${Math.round((a.ageMs ?? 0) / 60000)}min old`
              ),
              ...failed.map((r) => `${r.key}${r.error ? `: ${r.error}` : ""}`),
            ].join("; ")
          : null,
      p_extra: {
        duration_ms: Date.now() - startedMs,
        warmed: okCount,
        total: results.length,
        boards: results.map((r) => ({ key: r.key, ok: r.ok, row_count: r.rowCount })),
        // Cumulative view — queryable per board, so a streak is visible without
        // reconstructing it from per-tick rows (which prune at ~73h).
        stale_ceiling_min: Math.round(BOARD_SNAPSHOT_STALE_CEILING_MS / 60000),
        stale_boards: stale.map((a) => ({
          key: a.key,
          age_min: Math.round((a.ageMs ?? 0) / 60000),
        })),
        never_warmed: neverWarmed.map((a) => a.key),
        snapshot_age_min: Object.fromEntries(
          ages.map((a) => [a.key, a.ageMs == null ? null : Math.round(a.ageMs / 60000)])
        ),
      },
    })
  } catch (logErr) {
    console.log(
      `[${PIPELINE_NAME}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`
    )
  }

  return NextResponse.json({
    ok,
    pipeline: PIPELINE_NAME,
    warmed: okCount,
    total: results.length,
    boards: results,
    stale_boards: stale.map((a) => ({ key: a.key, age_min: Math.round((a.ageMs ?? 0) / 60000) })),
    never_warmed: neverWarmed.map((a) => a.key),
  })
}

export async function POST(request: NextRequest) {
  return run(request)
}

export async function GET(request: NextRequest) {
  return run(request)
}
