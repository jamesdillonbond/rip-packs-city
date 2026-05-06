// sync-nba-games — RETIRED 2026-05-06.
// sync-nba-projections now writes both nba_games and nba_player_projections in a
// single call. This route returns 410 Gone so cron-job.org callers do not 404
// and pipeline_runs entries (if any cron still exists) record an explicit reason
// instead of fetch_failed timeout errors. Disable the cron-job.org schedule
// after this deploys.

Deno.serve(() =>
  new Response(
    JSON.stringify({
      error: "retired",
      message:
        "sync-nba-games has been retired. The sync-nba-projections function now handles both tables in a single call.",
      retired_at: "2026-05-06",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
)
