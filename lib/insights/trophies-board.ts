// lib/insights/trophies-board.ts
//
// The single query behind the grails/trophies board, shared by BOTH consumers:
// `app/insights/trophies/page.tsx` (server-renders the default view so the
// ranked grails and their drill-down links are crawlable) and
// `app/api/public/insights/trophies/route.ts` (the client's filtered refetches).
//
// Same rationale as lib/insights/allday-scarcity-board.ts — see that file for
// the full "why". Short version: both consumers held their own copy of the
// column list and ordering, so adding a column to one silently diverged the
// server-rendered html from the client's first refetch; and the page's copy sat
// in `app/**/page.tsx`, which NEITHER coverage gate measures.
//
// ⚠ DEFAULTS ARE NOT SHARED. The page pins `limit: 200`; the route defaults to
// 200 but caps at 500 for a direct API caller. This module owns the QUERY.

import { supabaseAdmin } from "@/lib/supabase"

/** Columns both consumers select. Duplicating this list was the drift risk. */
export const TROPHIES_COLS =
  "edition_id, external_id, collection, collection_id, name, player_name, set_name, team_name, tier, series, circulation_count, thumbnail_url, video_url, is_one_of_one, is_ultimate, fmv_usd, confidence, fmv_computed_at"

export interface TrophiesBoardOptions {
  collection?: string | null
  /** "one_of_one" | "ultimate" | null — the two grail classes the view exposes. */
  type?: string | null
  sort?: string
  limit: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/** Returns supabase-js's `{ data, error }` untouched so each caller keeps its
 * own failure policy (503-without-leak for the route, `ok:false` for the page). */
export async function fetchTrophiesBoard(
  opts: TrophiesBoardOptions,
  db: Db = supabaseAdmin,
): Promise<{ data: unknown[] | null; error: { message: string } | null }> {
  const { collection = null, type = null, sort = "fmv", limit } = opts

  let q = db.from("v_insights_trophies").select(TROPHIES_COLS)

  if (collection) q = q.eq("collection", collection)
  if (type === "one_of_one") q = q.eq("is_one_of_one", true)
  else if (type === "ultimate") q = q.eq("is_ultimate", true)

  // FMV-desc (nulls last) is the canonical "headline grails first" ranking, so
  // the priced trophies lead and the never-traded grails follow. Both orderings
  // carry a tiebreak on purpose: without it two equal-FMV grails order
  // arbitrarily and the server html can disagree with the client refetch.
  if (sort === "circulation") {
    q = q
      .order("circulation_count", { ascending: true, nullsFirst: false })
      .order("fmv_usd", { ascending: false, nullsFirst: false })
  } else {
    q = q
      .order("fmv_usd", { ascending: false, nullsFirst: false })
      .order("circulation_count", { ascending: true, nullsFirst: false })
  }

  return q.limit(limit)
}
