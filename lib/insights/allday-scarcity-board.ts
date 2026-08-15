// lib/insights/allday-scarcity-board.ts
//
// The single query behind the All Day scarcity board, shared by BOTH consumers.
//
// ── WHY IT IS SHARED ───────────────────────────────────────────────────────
// The board is served twice: `app/insights/allday-scarcity/page.tsx` renders the
// default view server-side (so the ranked rows and their drill-down links are
// crawlable) and `app/api/public/insights/allday-scarcity/route.ts` serves the
// client's filtered refetches. Both carried their OWN copy of the query, and the
// page's comment said it read the view "exactly as the API route does" — a claim
// nothing enforced.
//
// The copies were verified identical when this was extracted (2026-08-15), so
// this fixes no live defect. What it removes is the way they would drift: the
// column list is duplicated verbatim, and adding a column to the route alone
// would leave the SERVER-RENDERED html missing it while the client's first
// refetch silently filled it in — visible only as a flash, and only to someone
// looking for it.
//
// It also takes the page off `server-page-data-access-ratchet`, which is the
// other half of the point: `app/**/page.tsx` is measured by neither coverage
// gate, so the page's copy of this query was untestable where the route's is not.
//
// ⚠ THE DEFAULTS ARE NOT SHARED, DELIBERATELY. The page pins `limit: 100` and
// the route defaults to `50`. That looks like drift and is not: the client
// refetches with an explicit `limit=100`, so the board is consistent, and the
// route's 50 is the courtesy default for a direct API caller. Collapsing them
// would change one surface or the other. Callers pass their own options; this
// module owns the QUERY, not the policy.

import { supabaseAdmin } from "@/lib/supabase"

/** Columns both consumers select. Duplicating this list was the drift risk. */
export const ALLDAY_SCARCITY_COLS =
  "external_id, player_name, set_name, tier, team_name, series, mint_count, family_avg_mint, family_size, scarcity_vs_family_pct, fmv_usd, fmv_confidence, thumbnail_url"

export const ALLDAY_SCARCITY_SORTS = new Set(["scarcity", "mint", "fmv"])

export interface AllDayScarcityOptions {
  tier?: string | null
  set?: string | null
  maxMint?: number | null
  /** Cohort gate: families large enough for their average to mean anything. */
  minFamilySize?: number | null
  /** Default 0 → only editions actually scarcer than their family. */
  minScarcity?: number | null
  sort?: string
  limit: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/**
 * Build and run the board query.
 *
 * Returns supabase-js's `{ data, error }` untouched so each caller keeps its own
 * failure policy — the route needs `boardUnavailable(error, …)` to publish a
 * 503 without leaking the driver message, while the page needs `ok:false` to
 * render the degraded notice. Normalising here would force one of them to
 * re-derive what it lost.
 */
export async function fetchAllDayScarcityBoard(
  opts: AllDayScarcityOptions,
  db: Db = supabaseAdmin,
): Promise<{ data: unknown[] | null; error: { message: string } | null }> {
  const { tier = null, set = null, maxMint = null, minFamilySize = 3, minScarcity = 0, sort = "scarcity", limit } = opts

  let q = db.from("allday_scarcity_board").select(ALLDAY_SCARCITY_COLS)

  // Cohort gate: only families with enough members to make the average mean
  // anything, and (by default) only editions actually scarcer than their family.
  if (Number.isFinite(minFamilySize)) q = q.gte("family_size", minFamilySize)
  if (Number.isFinite(minScarcity)) q = q.gt("scarcity_vs_family_pct", minScarcity)

  if (tier) q = q.eq("tier", tier.toUpperCase())
  if (set) q = q.ilike("set_name", `%${set}%`)
  if (maxMint != null && Number.isFinite(maxMint)) q = q.lte("mint_count", maxMint)

  if (sort === "scarcity") {
    q = q.order("scarcity_vs_family_pct", { ascending: false, nullsFirst: false })
  } else if (sort === "mint") {
    q = q.order("mint_count", { ascending: true })
  } else if (sort === "fmv") {
    q = q.order("fmv_usd", { ascending: false, nullsFirst: false })
  }

  return q.limit(limit)
}
