// lib/hot-floors/pinnacle.ts
//
// The read behind Disney Pinnacle's Hot Floors (/disney-pinnacle/hot-floors, Top Shot parity 2026-10-26):
// get_pinnacle_hot_floors(p_days) — pins (render_id, the pin grain) where one buyer took 3+ copies with no
// gap over 60 minutes, over pinnacle_sales (studio-history twins excluded). Top Shot's board detects sweeps on
// its Quick-Buy proposer; Pinnacle sales carry none, so this is the All Day / Panini buyer-session definition.
//
// Computed on the read path, not from a snapshot: measured 30 ms / 1.8k buffers (an index range on sold_at,
// floor and FMV are catalog columns). All Day's board needed a snapshot because its per-edition floor lookup
// ran 5 s cold; this one has no such lookup.
//
// Same honesty contract as the Top Shot read (lib/hot-floors/fetchers.ts): `ok` answers "did the READ
// succeed", never "were there sweeps"; a payload whose `editions` is not an array is a failed read, not an
// empty market.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { HOT_FLOORS_TIMEOUT_MS } from "@/lib/hot-floors/fetchers"

/** Seven days, like All Day: Pinnacle's market is small (2,127 non-studio sales in the 7 days to 2026-10-26). */
export const PINNACLE_HOT_FLOORS_DAYS = 7

export interface PinnacleHotPin {
  /** The pin's render_id — the board links /pinnacle/moment/<render_id>. */
  external_id: string
  /** The pin's character name. */
  player_name: string | null
  set_name: string | null
  /** The pin's variant (e.g. "Silver Sparkle"). */
  tier: string | null
  /** total_minted. */
  circulation_count: number | null
  thumbnail_url: string | null
  sweep_buyers: number
  swept_sales: number
  swept_spend: number | null
  last_swept_at: string | null
  floor_ask: number | null
  /** pinnacle_catalog.floor_ask_updated_at — written by the listing sweep on every pass: a CHECKED stamp. */
  floor_ask_verified_at: string | null
  fmv_usd: number | null
}

export interface PinnacleHotFloorsResult {
  editions: PinnacleHotPin[]
  ok: boolean
  /** Newest on-chain Pinnacle sale in the last 30 days — how current "the last N days" is. */
  newestSaleAt: string | null
}

export async function fetchPinnacleHotFloors(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
  timeoutMs: number = HOT_FLOORS_TIMEOUT_MS,
): Promise<PinnacleHotFloorsResult> {
  const failed: PinnacleHotFloorsResult = { editions: [], ok: false, newestSaleAt: null }
  try {
    const { data, error } = await withBoardBudget<{
      data: { editions?: unknown; newest_sale_at?: unknown } | null
      error: { message: string } | null
    }>(db.rpc("get_pinnacle_hot_floors", { p_days: PINNACLE_HOT_FLOORS_DAYS }), "pinnacle-hot-floors", timeoutMs, "collection/")
    if (error) {
      console.error("[pinnacle-hot-floors] read error:", error.message)
      return failed
    }
    const rows = data?.editions
    if (rows == null || !Array.isArray(rows)) {
      console.error("[pinnacle-hot-floors] unexpected payload shape")
      return failed
    }
    return {
      editions: rows as PinnacleHotPin[],
      ok: true,
      newestSaleAt: typeof data?.newest_sale_at === "string" ? data.newest_sale_at : null,
    }
  } catch (e) {
    console.error("[pinnacle-hot-floors] read bound:", e instanceof Error ? e.message : e)
    return failed
  }
}
