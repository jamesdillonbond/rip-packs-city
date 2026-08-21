import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"

// Multi-collection acquisitions classification cron.
//
// NBA Top Shot already has its own classify_acquisition path. This route
// handles AllDay / Golazos / UFC by calling the SECDEF helper
// backfill_acquisitions_for_collection(uuid, limit) once per collection.
// Pinnacle uses pinnacle_sales (separate schema) and is excluded.
//
// Bearer auth on INGEST_SECRET_TOKEN. Schedule from cron-job.org hourly.

export const maxDuration = 120
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "classify-acquisitions-multicollection"

const PER_COLLECTION_LIMIT = 500

// Bounded candidate window for All Day. Cost is sharply non-linear, measured
// end-to-end against prod 2026-08-03 (steady state, 0 candidates found):
//   unbounded -> TIMEOUT (>90s)   45d -> 34.8s   14d -> 3.5s
// 14 days is a very generous re-check window for an HOURLY job (only 23
// candidates appeared across the whole last 7 days) and leaves ~25x headroom
// under the fn's 90s statement_timeout, so a cold cache can't push it over.
// It is a re-check WINDOW, not a strict watermark: a sale whose wallet lands in
// wmc late still gets picked up on any tick within 14 days of the sale.
const ALLDAY_WINDOW_DAYS = 14

const TARGETS: Array<{
  slug: string
  collection_id: string
  limit?: number
  /** Bound the candidate scan to sales at-or-after now()-N days. Omit = unbounded. */
  sinceDays?: number
}> = [
  // AllDay MUST pass a window. The candidate scan drives off the partitioned
  // `sales` table oldest-first via bitmap heap scans that cannot stream, so it
  // spent its whole 90s statement_timeout proving the ~612k already-classified
  // 2022-2025 rows were empty and died BEFORE reaching the 2026 partition where
  // every real candidate lives — then the overrun pushed this route's after()
  // loop past maxDuration and the lambda was killed before log_pipeline_run,
  // which read as a missing cron trigger (24 runs/day -> ~9).
  //
  // NOTE: `limit` is NOT the lever here — measured `processed` per tick was
  // 0,1,3,9,20,35 against limit 80, so the limit almost never binds. Lowering it
  // (as an older comment here advised) changes nothing; bounding sold_at does.
  { slug: "nfl_all_day",      collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070", limit: 80, sinceDays: ALLDAY_WINDOW_DAYS },
  // Golazos: 78k sales, unbounded scan measured at 0.2s. Cheap enough to keep
  // draining its full history, so no window.
  { slug: "laliga_golazos",   collection_id: "06248cc4-b85f-47cd-af67-1855d14acd75" },
  // UFC: 813k sales and the SAME waste All Day had — measured 68.3s per tick to
  // prove an empty candidate set, every hour. Its market is CLOSED (last sale
  // 2026-05-13), so no new candidate can ever appear, and an unbounded scan
  // returning processed=0 is itself the proof that the historical tail is fully
  // drained. Left unbounded it was the dominant cost of the after() loop and
  // consumed most of the 120s maxDuration headroom on its own, which is how the
  // whole tick got killed before log_pipeline_run. Windowed for the same reason
  // as All Day; if UFC ever trades again the window picks it straight back up.
  { slug: "ufc_strike",       collection_id: "9b4824a8-736d-4a96-b450-8dcc0c46b023", sinceDays: ALLDAY_WINDOW_DAYS },
]

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  if (!TOKEN || bearer !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()

  // Synchronous invoked-marker. The classify loop + its terminal log both live
  // inside after(); when the All Day leg overran, the lambda was killed before
  // log_pipeline_run and the tick left NO pipeline_runs row at all — which is
  // indistinguishable from "the cron never fired" and sent a prior investigation
  // to the cron-job.org console instead of the slow query. This row is written
  // before any work, so a dropped after() now reads as `phase: "invoked"` with
  // no terminal row. Same repair already applied to allday-pack-listings and
  // pinnacle-sync. Best-effort: never fail the request on a logging error.
  // ⚠ 2026-08-20: this marker used to be written under the pipeline's OWN name,
  // and that DEFEATED the alarm it was added to protect. `detect_stalled_pipelines()`
  // computes `max(started_at) FROM pipeline_runs WHERE pipeline = w.pipeline` with
  // NO phase filter, so a self-named marker refreshes `last_run` on every tick and
  // the arm can never fire, however many after() bodies die. This pipeline carried
  // 70 markers against 122 total rows on a 180-min arm. The marker now goes under
  // `<pipeline>-heartbeat` via lib/pipeline/heartbeat.ts — the three states stay
  // readable and the stall arm goes back to measuring real completions.
  //
  // ⚠ The comment that stood here said "Same repair already applied to
  // allday-pack-listings and pinnacle-sync". It had spread to FOUR routes by
  // copy-paste, defect included — the documented reason to grep for the
  // EXPRESSION rather than the file.
  await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: Date.parse(startedAtIso) })

  // 202 + after(): the 3-collection classify loop (maxDuration=120) can exceed
  // cron-job.org's 30s client cap under DB saturation; auth stays sync, the
  // loop + log_pipeline_run move into after(), and we return immediately so the
  // entry can never be auto-disabled. pipeline_runs is the real success signal.
  after(async () => {
    const perCollection: Record<string, unknown> = {}
    let totalFound = 0
    let totalWritten = 0
    let totalSkipped = 0
    let firstError: string | null = null

    for (const t of TARGETS) {
      try {
        const { data, error } = await (supabaseAdmin as any).rpc(
          "backfill_acquisitions_for_collection",
          {
            p_collection_id: t.collection_id,
            p_limit: t.limit ?? PER_COLLECTION_LIMIT,
            p_since:
              t.sinceDays == null
                ? null
                : new Date(Date.now() - t.sinceDays * 24 * 60 * 60 * 1000).toISOString(),
          }
        )
        if (error) {
          firstError = firstError ?? `${t.slug}: ${error.message}`
          perCollection[t.slug] = { ok: false, error: error.message }
          continue
        }
        const found = Number((data as any)?.scanned ?? (data as any)?.rows_found ?? 0) || 0
        const written = Number((data as any)?.classified ?? (data as any)?.inserted ?? (data as any)?.rows_written ?? 0) || 0
        const skipped = Number((data as any)?.skipped ?? (data as any)?.rows_skipped ?? 0) || 0
        totalFound += found
        totalWritten += written
        totalSkipped += skipped
        perCollection[t.slug] = { ok: true, found, written, skipped, raw: data }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        firstError = firstError ?? `${t.slug}: ${msg}`
        perCollection[t.slug] = { ok: false, error: msg }
      }
    }

    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAtIso,
        p_rows_found: totalFound,
        p_rows_written: totalWritten,
        p_rows_skipped: totalSkipped,
        p_ok: !firstError,
        p_error: firstError,
        p_collection_slug: null,
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: { per_collection: perCollection },
      })
    } catch (e) {
      console.log(
        `[classify-acquisitions-multicollection] log_pipeline_run err: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  })

  return NextResponse.json(
    { ok: true, accepted: true, pipeline: PIPELINE_NAME },
    { status: 202 }
  )
}
