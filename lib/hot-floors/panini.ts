// lib/hot-floors/panini.ts
//
// The read behind Panini's Hot Floors (/panini-blockchain/hot-floors, Top Shot parity 2026-10-25):
// get_panini_hot_floors(p_days) — editions where one buyer took 3+ copies with no gap over 60 minutes,
// over sales ON RECORD. Bounded like the Top Shot read (lib/hot-floors/fetchers.ts) and with the same
// honesty contract: `ok` answers "did the READ succeed", never "were there sweeps"; a payload whose
// `editions` is not an array is a failed read, not an empty market.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { HOT_FLOORS_TIMEOUT_MS } from "@/lib/hot-floors/fetchers"

/** Panini sales reach RPC 12–160 h after they happen, so Top Shot's 3-day window would read mostly empty. */
export const PANINI_HOT_FLOORS_DAYS = 7

export interface PaniniHotEdition {
  external_id: string
  player_name: string | null
  set_name: string | null
  parallel: string | null
  mint_cap: number | null
  tier: string | null
  thumbnail_url: string | null
  sweep_buyers: number
  swept_sales: number
  swept_spend: number | null
  last_swept_at: string | null
  floor_ask: number | null
  fmv_usd: number | null
}

export interface PaniniHotFloorsResult {
  editions: PaniniHotEdition[]
  ok: boolean
  /** The newest sale on record (any edition) — how current "the last N days" really is. */
  newestSaleAt: string | null
}

export async function fetchPaniniHotFloors(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
  timeoutMs: number = HOT_FLOORS_TIMEOUT_MS,
): Promise<PaniniHotFloorsResult> {
  const failed: PaniniHotFloorsResult = { editions: [], ok: false, newestSaleAt: null }
  try {
    const { data, error } = await withBoardBudget<{
      data: { editions?: unknown; newest_sale_at?: unknown } | null
      error: { message: string } | null
    }>(db.rpc("get_panini_hot_floors", { p_days: PANINI_HOT_FLOORS_DAYS }), "panini-hot-floors", timeoutMs, "collection/")
    if (error) {
      console.error("[panini-hot-floors] read error:", error.message)
      return failed
    }
    const rows = data?.editions
    if (rows == null || !Array.isArray(rows)) {
      console.error("[panini-hot-floors] unexpected payload shape")
      return failed
    }
    return {
      editions: rows as PaniniHotEdition[],
      ok: true,
      newestSaleAt: typeof data?.newest_sale_at === "string" ? data.newest_sale_at : null,
    }
  } catch (e) {
    console.error("[panini-hot-floors] read bound:", e instanceof Error ? e.message : e)
    return failed
  }
}
