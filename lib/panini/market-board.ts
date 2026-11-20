// Panini Market board: where /api/market reads it from, and how long a stored copy is trusted.
// Kept out of the route file so a route exports only its handlers.
//
// `mv_panini_market_board` (migration audit_20261119_panini_market_board_mv) is a stored copy of
// the `panini_market_board` view + `computed_at`, refreshed every 30 min by pg_cron
// `rpc-panini-market-board`. The live view aggregates every listed serial per read (~500k
// buffers), which passed the route's 8 s bound on a cold cache (register R152).

export const PANINI_BOARD_STORED = "mv_panini_market_board"
export const PANINI_BOARD_LIVE = "panini_market_board"
// Four missed 30-minute refreshes: past this the copy is not answered from.
export const PANINI_BOARD_MAX_AGE_MS = 2 * 60 * 60 * 1000
/** True when the stored board's rows may be answered from. An EMPTY result is usable (a
 *  filter that matches nothing; the copy is never empty unfiltered, a refresh keeps the old
 *  rows on failure). Rows with no readable `computed_at`, or one older than the bound, are not. */
export function paniniStoredBoardIsFresh(rows: Array<{ computed_at?: string | null }> | null, nowMs: number): boolean {
  if (!rows) return false
  if (rows.length === 0) return true
  const t = Date.parse(String(rows[0]?.computed_at ?? ""))
  return Number.isFinite(t) && nowMs - t <= PANINI_BOARD_MAX_AGE_MS
}

/** CDN window for a Panini Market 200 (2026-11-19): answer from the copy, refresh behind the visitor. */
export const PANINI_MARKET_CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=3600"
