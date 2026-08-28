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
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"

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
  /** null when the count was not obtained — read `candidates_status` for WHY. */
  candidates_evaluated: number | null
  /**
   * Why `candidates_evaluated` is what it is. Before this existed, `null` meant
   * "the count RPC failed"; sampling would have overloaded it to also mean "we
   * chose not to count", making a broken telemetry RPC indistinguishable from a
   * deliberate skip — the exact conflation this repo keeps paying for.
   */
  candidates_status: "counted" | "failed" | "skipped"
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

// ── Candidate-count sampling ────────────────────────────────────────────────
//
// `candidates_evaluated` is DIAGNOSTIC telemetry, not an alarm: it exists so a
// 0-alert run is interpretable ("no candidates existed" vs "candidates existed
// but were threshold-rejected"). Nothing pages on it and no product surface
// reads it.
//
// It was costing more than the detectors it explains. Measured 2026-08-13 over a
// 39.7 h window: 402 calls, 44.7 GB of disk reads, 114 MB per call at 65.8%
// buffer hit — ~27 GB/day, roughly 3% of ALL disk reads on an IO-throttled
// Small tier. The shape is 3 collections × 4 detectors = 12 calls EVERY hourly
// tick, and each one re-scans the same 24 h `sales` window for that collection:
// `unusual_volume` and `floor_drops` are literally the same scan differing only
// in HAVING (>=5 vs >=3). The detectors' own output cannot substitute —
// detect_unusual_edition_volume returns `sales_examined_24h`, which is raw sale
// ROWS, not qualifying editions.
//
// The question it answers ("is the market thin or are the thresholds too tight")
// moves over weeks, not hours, so it is sampled every SAMPLE_EVERY_HOURS rather
// than hourly. Set INSIDER_CANDIDATE_COUNTS=always to restore hourly counting
// for a diagnostic window without a deploy.
//
// ⚠ The cheaper fix is a DB one and is NOT done here: a single RPC returning all
// four counts from ONE pass over the 24 h window would cut 12 scans to 3 while
// keeping hourly granularity. That needs a migration; this route change does not.
const SAMPLE_EVERY_HOURS = 6

export function shouldCountCandidates(at: Date, mode = process.env.INSIDER_CANDIDATE_COUNTS): boolean {
  if (mode === "always") return true
  if (mode === "never") return false
  return at.getUTCHours() % SAMPLE_EVERY_HOURS === 0
}

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
  // Invocation heartbeat, written BEFORE the work and awaited. `try/catch`
  // cannot catch a `maxDuration` kill: the platform terminates the function and
  // takes the terminal `log_pipeline_run` with it, so without a marker written
  // first a killed tick reads as a cron that never fired.
  //
  // ⭐ Selected on measured kill RISK: over 7 days this route's p90
  // `duration_ms` is 224,193 ms against its 300,000 ms ceiling (**75% of budget
  // at p90**), and its maximum reads 322,813 ms — ABOVE the ceiling. ⚠ That last
  // number is not evidence the lambda ran past its wall; `log_pipeline_run` has
  // no `p_finished_at`, so `finished_at` defaults to the INSERT time and the
  // recorded duration includes any retry/queueing delay on the terminal write.
  // It is a reason to distrust `duration_ms` as execution time here, and a
  // second reason to want a marker whose timestamps are pinned.
  await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: started })
  let ok = true
  let errMsg: string | null = null
  let result: any = null

  // Run the detectors ONE COLLECTION AT A TIME rather than as one combined
  // 3-collection RPC. run_all_insider_detectors runs all 5 detectors in a single
  // transaction, and during the 21:00-01:00 UTC peak the combined 3-collection
  // call consistently overran the Supabase RPC gateway (~185s) and was killed —
  // rolling back the WHOLE transaction, so every peak run emitted 0 alerts. Per-
  // collection calls commit independently: TS finishing (and committing its
  // alerts) no longer hinges on AllDay/UFC also beating the wall. Output is
  // identical (the union of the same per-collection results) — this is invocation
  // shape only, no detector-logic change. Query rewrites were ruled out: the
  // dominant early-buyer first-sale scan needs a global MIN(sold_at) per edition,
  // and the existing sequential-scan plan is already the fastest shape (anti-join
  // and hash-join rewrites both measured slower under contention, 88s / 29s vs 21s).
  result = {}
  const failed: string[] = []
  for (const slug of COLLECTIONS) {
    try {
      const { data, error } = await (supabaseAdmin as any).rpc(
        "run_all_insider_detectors",
        { p_collection_slugs: [slug] }
      )
      if (error) {
        failed.push(`${slug}: ${error.message}`)
      } else if (data && typeof data === "object") {
        Object.assign(result, data)
      }
    } catch (e) {
      failed.push(`${slug}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (failed.length > 0) {
    ok = false
    errMsg = failed.join(" | ")
  }

  // Candidate counts. These are NOT the "cheap COUNT(*)" this comment used to
  // claim — see the measurement above shouldCountCandidates(). They run even
  // when the main RPC failed, so a failed detector run still carries telemetry.
  const sampleCandidates = shouldCountCandidates(new Date(started))
  const blank = (): DetectorBreakdown => ({
    alerts_emitted: 0,
    candidates_evaluated: null,
    candidates_status: sampleCandidates ? "failed" : "skipped",
  })
  const perCollection: Record<string, PerCollectionTelemetry> = {}
  const totals: PerCollectionTelemetry = {
    unusual_volume: { alerts_emitted: 0, candidates_evaluated: sampleCandidates ? 0 : null, candidates_status: sampleCandidates ? "counted" : "skipped" },
    floor_drops: { alerts_emitted: 0, candidates_evaluated: sampleCandidates ? 0 : null, candidates_status: sampleCandidates ? "counted" : "skipped" },
    concentration_buys: { alerts_emitted: 0, candidates_evaluated: sampleCandidates ? 0 : null, candidates_status: sampleCandidates ? "counted" : "skipped" },
    early_buyers: { alerts_emitted: 0, candidates_evaluated: sampleCandidates ? 0 : null, candidates_status: sampleCandidates ? "counted" : "skipped" },
  }

  await Promise.all(
    COLLECTIONS.flatMap(slug =>
      DETECTOR_NAMES.map(async detector => {
        const candidates = sampleCandidates ? await countCandidates(slug, detector) : null
        const alerts = extractAlertsFromDetectorResult(result?.[slug]?.[detector])
        if (!perCollection[slug]) {
          perCollection[slug] = {
            unusual_volume: blank(),
            floor_drops: blank(),
            concentration_buys: blank(),
            early_buyers: blank(),
          }
        }
        perCollection[slug][detector] = {
          alerts_emitted: alerts,
          candidates_evaluated: candidates,
          candidates_status: !sampleCandidates ? "skipped" : candidates === null ? "failed" : "counted",
        }
        totals[detector].alerts_emitted += alerts
        if (typeof candidates === "number" && typeof totals[detector].candidates_evaluated === "number") {
          (totals[detector].candidates_evaluated as number) += candidates
        }
        // One failed count makes the TOTAL a partial sum, which would read as a
        // real (smaller) number. Say so instead of quietly under-reporting.
        if (sampleCandidates && candidates === null) totals[detector].candidates_status = "failed"
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
