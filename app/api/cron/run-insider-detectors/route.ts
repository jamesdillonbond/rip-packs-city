// app/api/cron/run-insider-detectors/route.ts
//
// Hourly insider-signal detector cron. Calls run_all_insider_detectors against
// nba_top_shot, nfl_all_day, ufc_strike. The RPC fans out to four detectors
// (unusual edition volume, floor drops, concentration buys, new-edition early
// buyers) and writes rows to topshot_insider_alerts.
//
// Bearer auth on INGEST_SECRET_TOKEN. Trevor schedules at cron-job.org hourly.
//
// Telemetry (2026-05-17): pipeline_runs.extra now carries per-detector
// candidates_evaluated AND alerts_emitted so we can see at a glance which
// detectors are silent because market activity is thin vs. because the
// thresholds are over-tuned. The 2026-05-17 dry-run audit found 0 candidates
// in the last 24h passing the unusual_volume (10x baseline), concentration_buy
// (≥5 copies/wallet/edition), or early_buyer (≥3 copies/wallet/edition in
// 48h window) gates — i.e. silence is currently expected under the current
// thresholds and current market activity. Loosening thresholds is unlikely
// to help without sufficient secondary-market volume.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
// 2026-06-10 (DBSAT residual fix): the detector RPC + 12 candidate-count RPCs
// ran synchronously and overran cron-job.org's 30s client cap ("Failed
// (timeout)"). Auth stays sync; we return 202 immediately and do all the work
// (incl. log_pipeline_run, which fires on the ok and error paths) in after().
export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "run-insider-detectors"
const COLLECTIONS = ["nba_top_shot", "nfl_all_day", "ufc_strike"]

interface DetectorBreakdown {
  alerts_emitted: number
  candidates_evaluated: number | null
}

interface PerCollectionTelemetry {
  unusual_volume: DetectorBreakdown
  floor_drops: DetectorBreakdown
  concentration_buys: DetectorBreakdown
  early_buyers: DetectorBreakdown
}

const DETECTOR_NAMES: Array<keyof PerCollectionTelemetry> = [
  "unusual_volume",
  "floor_drops",
  "concentration_buys",
  "early_buyers",
]

async function countCandidates(slug: string, detector: keyof PerCollectionTelemetry): Promise<number | null> {
  try {
    const { data, error } = await (supabaseAdmin as any).rpc(
      "count_insider_detector_candidates",
      { p_slug: slug, p_detector: detector }
    )
    if (error) {
      console.log(`[${PIPELINE_NAME}] candidate count ${detector}/${slug} err: ${error.message}`)
      return null
    }
    const n = Number(data ?? 0)
    if (!Number.isFinite(n) || n < 0) return null
    return n
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] candidate count ${detector}/${slug} threw: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

function extractAlertsFromDetectorResult(detectorJson: unknown): number {
  if (!detectorJson || typeof detectorJson !== "object") return 0
  const v = (detectorJson as Record<string, unknown>).alerts_inserted
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

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
  let result: any = null

  try {
    const { data, error } = await (supabaseAdmin as any).rpc(
      "run_all_insider_detectors",
      { p_collection_slugs: COLLECTIONS }
    )
    if (error) {
      ok = false
      errMsg = error.message
    } else {
      result = data
    }
  } catch (e) {
    ok = false
    errMsg = e instanceof Error ? e.message : String(e)
  }

  // Pull candidate counts in parallel. These are cheap COUNT(*) queries
  // (the same shape as each detector's outermost filtering CTE) and run
  // even when the main RPC failed so we always have some telemetry.
  const perCollection: Record<string, PerCollectionTelemetry> = {}
  const totals: PerCollectionTelemetry = {
    unusual_volume: { alerts_emitted: 0, candidates_evaluated: 0 },
    floor_drops: { alerts_emitted: 0, candidates_evaluated: 0 },
    concentration_buys: { alerts_emitted: 0, candidates_evaluated: 0 },
    early_buyers: { alerts_emitted: 0, candidates_evaluated: 0 },
  }

  await Promise.all(
    COLLECTIONS.flatMap(slug =>
      DETECTOR_NAMES.map(async detector => {
        const candidates = await countCandidates(slug, detector)
        const alerts = extractAlertsFromDetectorResult(result?.[slug]?.[detector])
        if (!perCollection[slug]) {
          perCollection[slug] = {
            unusual_volume: { alerts_emitted: 0, candidates_evaluated: null },
            floor_drops: { alerts_emitted: 0, candidates_evaluated: null },
            concentration_buys: { alerts_emitted: 0, candidates_evaluated: null },
            early_buyers: { alerts_emitted: 0, candidates_evaluated: null },
          }
        }
        perCollection[slug][detector] = { alerts_emitted: alerts, candidates_evaluated: candidates }
        totals[detector].alerts_emitted += alerts
        if (typeof candidates === "number" && typeof totals[detector].candidates_evaluated === "number") {
          (totals[detector].candidates_evaluated as number) += candidates
        }
      })
    )
  )

  const totalAlerts =
    totals.unusual_volume.alerts_emitted +
    totals.floor_drops.alerts_emitted +
    totals.concentration_buys.alerts_emitted +
    totals.early_buyers.alerts_emitted

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: 0,
      p_rows_written: totalAlerts,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: errMsg,
      p_collection_slug: null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        duration_ms: Date.now() - started,
        collections: COLLECTIONS,
        totals_by_detector: totals,
        per_collection: perCollection,
        detector_result: result,
      },
    })
  } catch (e) {
    console.log(
      `[run-insider-detectors] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  })

  return NextResponse.json(
    { accepted: true, pipeline: PIPELINE_NAME, started_at: startedAtIso },
    { status: 202 }
  )
}
