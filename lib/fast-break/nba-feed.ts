// lib/fast-break/nba-feed.ts
//
// Is the NBA feed ANSWERING? An empty slate is the NBA's schedule only when a
// writer of `nba_games` succeeded recently; otherwise it is OUR outage.
//
// TWO writers since 2026-10-23 (known-issues #8):
//   • `nba-espn-projections` — the pg_net DB lane (nba_espn_dispatch / drain,
//     pg_cron hourly). ESPN refuses the edge/Vercel egress but answers the
//     database's own; free, no key. Its `ok` is false when games exist today and
//     zero projections were written, so an ok run is a real slate read.
//   • `sync-nba-projections` — the edge function (DraftKings + ESPN via the
//     sports proxy). Failing since 2026-08-04 except a few opening-day runs; kept
//     because its DraftKings projections outrank ESPN's when they answer.
// Either one answering proves the slate read works.
//
// ONE copy, shared by `/api/fast-break/optimize` (dataStatus), the
// `/[collection]/fast-break` page (fetchSlate) and `/api/fast-break/today`, so
// they cannot disagree about whether tonight is an off-day.

// 36 h spans one missed daily tick; pipeline_runs retains ~73 h.
export const NBA_FEED_PIPELINES = ["nba-espn-projections", "sync-nba-projections"] as const
export const NBA_FEED_FRESH_MS = 36 * 60 * 60 * 1000

/**
 * True only when a feed writer demonstrably answered inside the window.
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
    .in("pipeline", [...NBA_FEED_PIPELINES])
    .eq("ok", true)
    .gte("started_at", since)
  if (error) console.error(`${logPrefix} feed freshness:`, error.message)
  return !error && typeof count === "number" && count > 0
}
