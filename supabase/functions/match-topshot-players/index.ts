// match-topshot-players — backfill that auto-aliases distinct
// wallet_moments_cache.player_name values to nba_players via pg_trgm
// similarity. Designed to run nightly; the actual SQL work happens inside
// the match_topshot_players_run() RPC (see migration of the same name).
//
// This edge function is a thin wrapper:
//   1. Calls the RPC (which does normalize + dedupe + fuzzy match + INSERT
//      INTO nba_player_aliases for unique high-confidence matches).
//   2. Surfaces the returned counts and needs_review array into
//      pipeline_runs.extras so manual review work doesn't get lost.
//
// Safe to run repeatedly. alias_normalized has a UNIQUE constraint, so
// re-runs collapse via ON CONFLICT DO NOTHING inside the RPC.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const FUNCTION_VERSION = 1
const PIPELINE = "match-topshot-players"
const COLLECTION_SLUG = "nba_top_shot"

interface MatchSummary {
  skipped: number
  auto_aliased: number
  total_unresolved: number
  needs_review: Array<{
    name: string
    owners: number
    best_sim: number | null
    candidate_count: number
  }>
}

async function logRun(args: {
  startedAt: string
  rowsFound: number
  rowsWritten: number
  rowsSkipped: number
  ok: boolean
  error?: string | null
  extra: Record<string, unknown>
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE,
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
  } catch (err) {
    console.log(`[match-topshot-players] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function runWork(startedAtIso: string, started: number) {
  const { data, error } = await supabase.rpc("match_topshot_players_run")

  if (error) {
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false,
      error: `rpc_failed: ${error.message}`,
      extra: { function_version: FUNCTION_VERSION, elapsed_ms: Date.now() - started },
    })
    return
  }

  const summary = (data ?? {}) as Partial<MatchSummary>
  const skipped = Number(summary.skipped ?? 0)
  const autoAliased = Number(summary.auto_aliased ?? 0)
  const totalUnresolved = Number(summary.total_unresolved ?? 0)
  const needsReview = Array.isArray(summary.needs_review) ? summary.needs_review : []

  await logRun({
    startedAt: startedAtIso,
    rowsFound: skipped + totalUnresolved,
    rowsWritten: autoAliased,
    rowsSkipped: skipped,
    ok: true,
    extra: {
      function_version: FUNCTION_VERSION,
      summary: {
        skipped,
        auto_aliased: autoAliased,
        total_unresolved: totalUnresolved,
        needs_review_count: needsReview.length,
      },
      needs_manual_review: needsReview.slice(0, 200),
      elapsed_ms: Date.now() - started,
    },
  })
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${INGEST_SECRET_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime
  const workPromise = runWork(startedAtIso, started)
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(workPromise)
  } else {
    workPromise.catch(e => console.log(`[match-topshot-players] waitUntil fallback err: ${e instanceof Error ? e.message : String(e)}`))
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: "queued",
      started_at: startedAtIso,
      function_version: FUNCTION_VERSION,
      note: "Real results will appear in pipeline_runs within ~5-15s.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})
