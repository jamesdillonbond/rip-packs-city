// lib/insights/set-squeeze-board.ts
//
// The single query behind the set-level squeeze leaderboard, shared by BOTH
// consumers: `app/insights/set-squeeze/page.tsx` and
// `app/api/public/insights/set-squeeze/route.ts`.
//
// Same rationale as lib/insights/allday-scarcity-board.ts — see that file for
// the full "why". The page's copy lived in `app/**/page.tsx`, which NEITHER
// coverage gate measures, while the route's identical copy was measured.
//
// ⚠ DEFAULTS ARE NOT SHARED. The page pins `limit: 100`; the route defaults to
// 50 (capped at 100) for a direct API caller.

import { supabaseAdmin } from "@/lib/supabase"

/** Columns both consumers select. Duplicating this list was the drift risk. */
export const SET_SQUEEZE_COLS =
  "set_id, set_name, series, set_tier, editions_covered, avg_squeeze_pct, median_squeeze_pct, max_squeeze_pct, min_squeeze_pct, total_circ, total_locked, total_burned, total_buyable, avg_fmv_usd, fmv_covered_editions"

export interface SetSqueezeBoardOptions {
  series?: number | null
  setTier?: string | null
  sort?: string
  limit: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/** Returns supabase-js's `{ data, error }` untouched so each caller keeps its
 * own failure policy (503-without-leak for the route, `ok:false` for the page). */
export async function fetchSetSqueezeBoard(
  opts: SetSqueezeBoardOptions,
  db: Db = supabaseAdmin,
): Promise<{ data: unknown[] | null; error: { message: string } | null }> {
  const { series = null, setTier = null, sort = "squeeze", limit } = opts

  let q = db.from("topshot_set_squeeze_board").select(SET_SQUEEZE_COLS)

  if (series != null) q = q.eq("series", series)
  if (setTier) q = q.eq("set_tier", setTier)

  if (sort === "squeeze") {
    q = q.order("avg_squeeze_pct", { ascending: false, nullsFirst: false })
  } else {
    q = q.order("total_buyable", { ascending: true })
  }

  return q.limit(limit)
}
