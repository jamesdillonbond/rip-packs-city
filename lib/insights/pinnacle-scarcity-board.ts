// lib/insights/pinnacle-scarcity-board.ts
//
// The single query behind the Pinnacle scarcity board, shared by BOTH
// consumers: `app/insights/pinnacle-scarcity/page.tsx` and
// `app/api/public/insights/pinnacle-scarcity/route.ts`.
//
// Same rationale as lib/insights/allday-scarcity-board.ts — see that file for
// the full "why". The page's copy lived in `app/**/page.tsx`, which NEITHER
// coverage gate measures.
//
// ⚠ DEFAULTS ARE NOT SHARED. The page pins `limit: 100`; the route defaults to
// 50 for a direct API caller.

import { supabaseAdmin } from "@/lib/supabase"

/** Columns both consumers select. Duplicating this list was the drift risk. */
export const PINNACLE_SCARCITY_COLS =
  "render_id, edition_id, character_name, franchise, set_name, variant_type, mint_count, is_chaser, floor_ask, variant_avg_mint, scarcity_vs_variant_pct, fmv_usd, fmv_confidence, image_url"

export interface PinnacleScarcityBoardOptions {
  variant?: string | null
  franchise?: string | null
  maxMint?: number | null
  chasersOnly?: boolean
  sort?: string
  limit: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/** Returns supabase-js's `{ data, error }` untouched so each caller keeps its
 * own failure policy (503-without-leak for the route, `ok:false` for the page). */
export async function fetchPinnacleScarcityBoard(
  opts: PinnacleScarcityBoardOptions,
  db: Db = supabaseAdmin,
): Promise<{ data: unknown[] | null; error: { message: string } | null }> {
  const { variant = null, franchise = null, maxMint = null, chasersOnly = false, sort = "scarcity", limit } = opts

  let q = db.from("pinnacle_scarcity_board").select(PINNACLE_SCARCITY_COLS)

  if (variant) q = q.ilike("variant_type", `%${variant}%`)
  if (franchise) q = q.ilike("franchise", `%${franchise}%`)
  if (maxMint != null && Number.isFinite(maxMint)) q = q.lte("mint_count", maxMint)
  if (chasersOnly) q = q.eq("is_chaser", true)

  if (sort === "scarcity") {
    q = q.order("scarcity_vs_variant_pct", { ascending: false, nullsFirst: false })
  } else if (sort === "mint") {
    q = q.order("mint_count", { ascending: true })
  } else if (sort === "fmv") {
    q = q.order("fmv_usd", { ascending: false, nullsFirst: false })
  }

  return q.limit(limit)
}
