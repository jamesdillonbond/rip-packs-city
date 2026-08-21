import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"

// POST /api/admin/drain-fmv-cold-tail?collection=all&limit=200
// Authorization: Bearer $INGEST_SECRET_TOKEN  OR  ?token=$INGEST_SECRET_TOKEN
//
// Drains the FMV cold tail for the 4 stale collections by calling the SECDEF
// RPC drain_fmv_cold_tail(p_collection_slug, p_limit). Closes audit §1.1
// (FMV freshness gap in non-AllDay collections). Pinnacle is intentionally
// excluded — it has its own per-render engine, pinnacle_fmv_recalc_render_all
// (→ pinnacle_catalog), run via the pinnacle-sync cron.
//
// ⚠ THE 2026-06 SIZING ASSUMPTION EXPIRED, SILENTLY (measured 2026-08-18).
// The original header promised "4 collections × ~200 = ~800 editions/tick at
// ~ms-per-edition cost. maxDuration=60 gives slack for pool contention." That
// is no longer true, and the cost is NOT per-edition:
//
//   • Over a 14h window the route took 28 invocations (~2/h, exactly its
//     30-minute schedule) and wrote only 9 pipeline_runs rows. All 28 returned
//     202. Vercel's error groups name the mechanism — `Vercel Runtime Timeout
//     Error: Task timed out after 60 seconds`, 21 occurrences, first
//     2026-06-16 — so the drain loop is being killed mid-flight.
//   • drain_fmv_cold_tail's candidate query opens with an UNSCOPED
//     `SELECT edition_id, MAX(computed_at) FROM fmv_snapshots GROUP BY 1`,
//     i.e. it aggregates the WHOLE table (1.16M rows) once per collection per
//     tick. Measured with EXPLAIN ANALYZE: 32.9s for ufc_strike — a
//     518-edition collection that returned ZERO candidates. p_limit bounds the
//     OUTPUT, not that scan, so LOWERING THE LIMIT DOES NOT CUT THE COST.
//
// Two consequences drive the shape of this handler:
//   (1) A killed tick wrote NO row at all, so it was indistinguishable from a
//       cron that never fired — the documented after() trap. Hence the
//       invocation heartbeat below, written BEFORE any drain work.
//   (2) A single slug can consume the whole 60s budget, so attempting all four
//       unconditionally guarantees the kill. Hence the deadline guard, and the
//       rotation that stops the guard from starving the tail of the list.
//
// The durable fix is DB-side (scope that aggregate to the collection); until
// then this route's job is to stay VISIBLE while it degrades.

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Wall-clock budget for the drain loop, well inside maxDuration so the
// pipeline_runs insert below always has room. Only checked BETWEEN slugs — a
// single in-flight RPC cannot be bounded from here (a function-level
// statement_timeout is inert, and service_role has no binding one), which is
// exactly why the heartbeat is not optional.
const DRAIN_BUDGET_MS = 45_000
// Floor for "how long will the next slug take", so one fast slug cannot make
// the estimate optimistic enough to start a slow one we cannot afford.
const SLUG_ESTIMATE_FLOOR_MS = 8_000

const STALE_COLLECTIONS = [
  "nba_top_shot",
  "nfl_all_day",
  "laliga_golazos",
  "ufc_strike",
] as const
type StaleSlug = (typeof STALE_COLLECTIONS)[number]

type ResultRow = {
  slug: string
  ok: boolean
  data: unknown
  error: string | null
}

function isAuthorized(req: NextRequest): boolean {
  const token = process.env.INGEST_SECRET_TOKEN
  if (!token) return false
  const auth = req.headers.get("authorization") ?? ""
  if (auth === `Bearer ${token}`) return true
  const qp = req.nextUrl.searchParams.get("token")
  return qp === token
}

function isStaleCollection(s: string): s is StaleSlug {
  return (STALE_COLLECTIONS as readonly string[]).includes(s)
}

// Deterministic 30-minute rotation (the schedule's own period), so the slug
// that goes first changes every tick. Without it the deadline guard is a
// starvation machine: nba_top_shot is both the first entry and the most
// expensive one, so it would be the only collection ever drained and the other
// three would go silent while the pipeline still reported ok.
function rotateSlugs<T>(slugs: readonly T[], atMs: number): T[] {
  if (slugs.length < 2) return [...slugs]
  const tick = Math.floor(atMs / (30 * 60 * 1000))
  const offset = ((tick % slugs.length) + slugs.length) % slugs.length
  return slugs.map((_, i) => slugs[(i + offset) % slugs.length])
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const collection = req.nextUrl.searchParams.get("collection") ?? "all"
  const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? 200)
  const limit = Math.min(
    Math.max(Number.isFinite(limitRaw) ? limitRaw : 200, 1),
    500
  )

  if (collection === "disney_pinnacle") {
    return NextResponse.json(
      { error: "pinnacle uses pinnacle_fmv_recalc — separate cron" },
      { status: 400 }
    )
  }

  let collections: StaleSlug[]
  if (collection === "all") {
    collections = [...STALE_COLLECTIONS]
  } else if (isStaleCollection(collection)) {
    collections = [collection]
  } else {
    return NextResponse.json(
      {
        error: `Unsupported collection: ${collection}`,
        supported: [...STALE_COLLECTIONS, "all"],
      },
      { status: 400 }
    )
  }

  const startedAt = Date.now()
  const order = rotateSlugs(collections, startedAt)

  // 202 + after(): collection=all drains ~800 editions/tick and can exceed
  // cron-job.org's 30s client cap under DB saturation; auth + param validation
  // stay sync, the drain loop + pipeline_runs insert move into after(), and we
  // return immediately so the entry can never be auto-disabled on a timeout.
  after(async () => {
    // ⚠ INVOCATION HEARTBEAT — written FIRST, before any drain work.
    //
    // 2026-08-18: the 202 is returned before the work starts, so the caller
    // sees success on a tick that is then killed at maxDuration. The drain loop
    // AND the terminal pipeline_runs insert both live in this after() body, so
    // a killed tick wrote nothing: no row, no ok=false, no error — identical to
    // a cron that never fired. 19 of 28 invocations vanished that way and the
    // pipeline looked merely "bursty" for two months.
    //
    // ⚠ The 2026-06-11 try/catch below CANNOT close this. It catches throws
    // INSIDE the loop; a platform timeout terminates the whole function,
    // terminal insert included. The first recorded timeout (2026-06-16) is five
    // days AFTER the hardening whose comment promises "every run must produce a
    // row" — the guard closed the failure mode inside the language and left the
    // one outside it.
    //
    // Same shape as fmv-recalc-heartbeat: a SEPARATE pipeline name so every
    // signal keyed on pipeline='drain-fmv-cold-tail' (cadence, detect_stalled,
    // the watchlist) is untouched, ok stays true so no ok=false alert fires,
    // and finished_at is pinned to started_at because duration_ms is GENERATED
    // from the pair and would otherwise publish this INSERT's own latency as a
    // run duration. Kills are read by CORRELATION, not by a finalize step
    // (a finally does not run reliably under the lambda lifecycle):
    //   SELECT hb.started_at FROM pipeline_runs hb
    //   WHERE hb.pipeline = 'drain-fmv-cold-tail-heartbeat'
    //     AND hb.started_at < now() - interval '10 minutes'
    //     AND NOT EXISTS (SELECT 1 FROM pipeline_runs dr
    //       WHERE dr.pipeline = 'drain-fmv-cold-tail'
    //         AND dr.started_at BETWEEN hb.started_at - interval '5 s'
    //                              AND hb.started_at + interval '5 s');  -- = kills
    // 2026-08-20: moved to `lib/pipeline/heartbeat.ts`. This site was the ONLY
    // one of five that had the row shape fully right, so the helper was written
    // from it — but even here `rows_skipped` was omitted and therefore took the
    // column default 0, so the "explicitly NULL" comment was two-thirds true.
    // That is the argument for one implementation in one place.
    await writeInvocationHeartbeat({
      pipeline: "drain-fmv-cold-tail",
      startedAtMs: startedAt,
      extra: {
        collection_filter: collection,
        limit,
        order,
        budget_ms: DRAIN_BUDGET_MS,
        max_duration_s: 60,
      },
    })

    const results: ResultRow[] = []
    const skipped: string[] = []
    let longestSlugMs = 0

    // 2026-06-11: per-slug RPC wrapped in try/catch so a THROW (pool timeout
    // under saturation, not a returned error) on one collection no longer
    // rejects the whole after() before the pipeline_runs insert below — every
    // run must produce a row even when a slug fails hard.
    for (const slug of order) {
      // 2026-08-18 deadline guard. Skipping a slug is NOT a failure and is not
      // silent — `extra.skipped` names every one, and slugs_attempted /
      // slugs_total sit beside rows_found so a partial tick can never be read
      // as "nothing left to reprice". The first slug is always attempted, so a
      // tick can never do nothing at all.
      const elapsed = Date.now() - startedAt
      const estimate = Math.max(longestSlugMs, SLUG_ESTIMATE_FLOOR_MS)
      if (results.length > 0 && elapsed + estimate > DRAIN_BUDGET_MS) {
        skipped.push(slug)
        continue
      }

      const slugStartedAt = Date.now()
      try {
        const { data, error } = await (supabaseAdmin as any).rpc(
          "drain_fmv_cold_tail",
          {
            p_collection_slug: slug,
            p_limit: limit,
          }
        )
        results.push({
          slug,
          ok: !error,
          data: error ? null : data,
          error: error?.message ?? null,
        })
      } catch (e) {
        results.push({
          slug,
          ok: false,
          data: null,
          error: e instanceof Error ? e.message : String(e),
        })
      }
      longestSlugMs = Math.max(longestSlugMs, Date.now() - slugStartedAt)
    }

    const allOk = results.every((r) => r.ok)
    const durationMs = Date.now() - startedAt

    // `processed` is the edition count this tick actually repriced, and it is
    // ALSO the write count: every branch of drain_fmv_cold_tail's loop performs
    // exactly one `INSERT INTO fmv_snapshots` (with_sales / ask_only / stale /
    // no_data) before incrementing v_processed, so processed == rows inserted.
    // Mapping it to both columns is therefore a measurement, not an estimate.
    //
    // ⚠ These were previously OMITTED from the insert, so they defaulted to 0
    // and this pipeline reported `rows_found: 0, rows_written: 0` on EVERY run
    // while doing real work (5-71 editions/tick, visible only by hand-reading
    // `extra.results[].data.processed`). That made a live FMV WRITER — it
    // stamps algo_version 'cold-tail-1.0' snapshots whose confidence labels
    // feed the roadmap's headline HIGH/MEDIUM-share metric — look inert in
    // `pipeline_runs_daily` and in any sweep for zero-output pipelines. A
    // 2026-08-16 sweep for retirable crons flagged it as waste on exactly that
    // signal; it is not waste.
    //
    // The optional chain is load-bearing and mutation-proven: a hard RPC failure
    // (pool timeout under saturation — the case the try/catch above exists for)
    // leaves `data` null, and without `?.` this throws inside after(), losing the
    // pipeline_runs row entirely. Counting a failed leg as 0 is correct rather
    // than unknown; `ok` already carries the failure.
    //
    // ⚠ The `typeof`/`isFinite` check, by contrast, is DEFENSIVE ONLY and is not
    // reachable from this RPC's contract: drain_fmv_cold_tail returns
    // `jsonb_build_object('processed', v_processed)` with v_processed INT, so
    // `processed` is always a JSON number, and its only other return path (the
    // 'unknown collection' guard) omits the key entirely — which `?.` plus `?? 0`
    // already handles. Mutating it away leaves every test green; it is kept as
    // cheap insurance, NOT asserted, and would become load-bearing only if that
    // function started returning a non-numeric `processed`.
    const totalProcessed = results.reduce((sum, r) => {
      const processed = (r.data as { processed?: unknown } | null)?.processed
      return sum + (typeof processed === "number" && Number.isFinite(processed) ? processed : 0)
    }, 0)

    try {
      // started_at is NOT NULL on pipeline_runs. The 2026-05-17 pg_log
      // "null value in column started_at violates not-null constraint"
      // alert traced back to this insert. We use startedAt (the run-begin
      // marker captured at the top of POST handler) so the row is
      // chronologically correct rather than now()-only.
      await (supabaseAdmin as any).from("pipeline_runs").insert({
        pipeline: "drain-fmv-cold-tail",
        started_at: new Date(startedAt).toISOString(),
        finished_at: new Date().toISOString(),
        ok: allOk,
        rows_found: totalProcessed,
        rows_written: totalProcessed,
        extra: {
          collection_filter: collection,
          limit,
          duration_ms: durationMs,
          order,
          skipped,
          deadline_hit: skipped.length > 0,
          budget_ms: DRAIN_BUDGET_MS,
          slugs_attempted: results.length,
          slugs_total: order.length,
          results,
        },
      })
    } catch (err) {
      console.warn(
        `[drain-fmv-cold-tail] pipeline_runs insert failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  })

  return NextResponse.json(
    {
      ok: true,
      accepted: true,
      pipeline: "drain-fmv-cold-tail",
      collection_filter: collection,
      limit,
    },
    { status: 202 }
  )
}
