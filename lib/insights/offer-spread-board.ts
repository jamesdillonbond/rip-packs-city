// lib/insights/offer-spread-board.ts
//
// The single query behind the offer-vs-ask spread board, shared by BOTH
// consumers: `app/insights/offer-spread/page.tsx` and
// `app/api/public/insights/offer-spread/route.ts`.
//
// Same rationale as lib/insights/allday-scarcity-board.ts — see that file for
// the full "why". The page's copy lived in `app/**/page.tsx`, which NEITHER
// coverage gate measures.
//
// ⚠ THE `low_ask >= minAsk` FLOOR IS PART OF THE QUERY, not a filter. Both
// consumers apply it: below it the spread percentages are dominated by dust
// asks, so an unfloored board ranks noise at the top of a surface whose whole
// claim is "these bids are closest to their ask". The page pins 5 and the route
// exposes it as `min_ask` with the same default.

import { supabaseAdmin } from "@/lib/supabase"

/** Columns both consumers select. Duplicating this list was the drift risk. */
export const OFFER_SPREAD_COLS =
  "external_id, name, player_name, set_name, tier, circulation_count, highest_offer, low_ask, offer_pct_of_ask, par_distance, spread_usd, bid_meets_ask, updated_at"

export interface OfferSpreadBoardOptions {
  tier?: string | null
  set?: string | null
  player?: string | null
  bidMeetsAsk?: boolean
  /** Dust floor on low_ask. See the note above — not an optional nicety. */
  minAsk?: number
  sort?: string
  limit: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/** Returns supabase-js's `{ data, error }` untouched so each caller keeps its
 * own failure policy (503-without-leak for the route, `ok:false` for the page). */
export async function fetchOfferSpreadBoard(
  opts: OfferSpreadBoardOptions,
  db: Db = supabaseAdmin,
): Promise<{ data: unknown[] | null; error: { message: string } | null }> {
  const {
    tier = null,
    set = null,
    player = null,
    bidMeetsAsk = false,
    minAsk = 5,
    sort = "par",
    limit,
  } = opts

  let q = db.from("topshot_offer_ask_spread").select(OFFER_SPREAD_COLS).gte("low_ask", minAsk)

  if (tier) q = q.eq("tier", tier)
  if (bidMeetsAsk) q = q.eq("bid_meets_ask", true)
  if (set) q = q.ilike("set_name", `%${set}%`)
  if (player) q = q.ilike("player_name", `%${player}%`)

  if (sort === "par") q = q.order("par_distance", { ascending: true })
  else if (sort === "spread") q = q.order("spread_usd", { ascending: true })
  else if (sort === "offer") q = q.order("highest_offer", { ascending: false })
  else if (sort === "ask") q = q.order("low_ask", { ascending: false })
  else if (sort === "pct") q = q.order("offer_pct_of_ask", { ascending: false })

  return q.limit(limit)
}
