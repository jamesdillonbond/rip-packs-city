import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// POST /api/admin/drain-fmv-cold-tail?collection=all&limit=200
// Authorization: Bearer $INGEST_SECRET_TOKEN  OR  ?token=$INGEST_SECRET_TOKEN
//
// Drains the FMV cold tail for the 4 stale collections by calling the SECDEF
// RPC drain_fmv_cold_tail(p_collection_slug, p_limit). Closes audit §1.1
// (FMV freshness gap in non-AllDay collections). Pinnacle is intentionally
// excluded — it has its own per-render engine, pinnacle_fmv_recalc_render_all
// (→ pinnacle_catalog), run via the pinnacle-sync cron.
//
// Designed for cron-job.org's 30s free-tier timeout when called with the
// default limit=200 and collection=all (4 collections × ~200 = ~800
// editions/tick at ~ms-per-edition cost). maxDuration=60 gives slack for
// pool contention.

export const dynamic = "force-dynamic"
export const maxDuration = 60

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

  // 202 + after(): collection=all drains ~800 editions/tick and can exceed
  // cron-job.org's 30s client cap under DB saturation; auth + param validation
  // stay sync, the drain loop + pipeline_runs insert move into after(), and we
  // return immediately so the entry can never be auto-disabled on a timeout.
  after(async () => {
    const results: ResultRow[] = []

    // 2026-06-11: per-slug RPC wrapped in try/catch so a THROW (pool timeout
    // under saturation, not a returned error) on one collection no longer
    // rejects the whole after() before the pipeline_runs insert below — every
    // run must produce a row even when a slug fails hard.
    for (const slug of collections) {
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
