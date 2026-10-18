// lib/fast-break/nba-feed.ts
//
// Is the NBA feed ANSWERING? `sync-nba-projections` is the sole writer of
// `nba_games` (known-issues #8: every upstream has 403'd since 2026-08-04 and no
// paid provider is bought before revenue). An empty slate is the NBA's schedule
// only when that writer succeeded recently; otherwise it is OUR outage.
//
// ONE copy, shared by `/api/fast-break/optimize` (dataStatus) and the
// `/[collection]/fast-break` page (fetchSlate), so the two cannot disagree about
// whether tonight is an off-day.

// 36 h spans one missed daily tick; pipeline_runs retains ~73 h.
export const NBA_FEED_PIPELINE = "sync-nba-projections"
export const NBA_FEED_FRESH_MS = 36 * 60 * 60 * 1000

/**
 * True only when the feed demonstrably answered inside the window.
 *
 * ⚠ A failed or unreadable check proves nothing about the feed, so it returns
 * false: callers then keep the outage wording rather than asserting an off-day
 * they could not confirm.
 */
export async function nbaFeedAnsweredRecently(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  logPrefix: string,
): Promise<boolean> {
  const since = new Date(Date.now() - NBA_FEED_FRESH_MS).toISOString()
  const { count, error } = await db
    .from("pipeline_runs")
    .select("id", { count: "exact", head: true })
    .eq("pipeline", NBA_FEED_PIPELINE)
    .eq("ok", true)
    .gte("started_at", since)
  if (error) console.error(`${logPrefix} feed freshness:`, error.message)
  return !error && typeof count === "number" && count > 0
}
