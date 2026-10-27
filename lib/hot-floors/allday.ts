// lib/hot-floors/allday.ts
//
// The read behind NFL All Day's Hot Floors (/nfl-all-day/hot-floors, Top Shot parity 2026-10-26):
// get_allday_hot_floors(p_days) — editions where one buyer took 3+ copies with no gap over 60 minutes,
// over sales_market (pack buybacks excluded). Top Shot's board detects sweeps on its Quick-Buy proposer;
// All Day sales carry no proposer, so this is Panini's buyer-session definition instead.
//
// Bounded like the Top Shot read (lib/hot-floors/fetchers.ts) and with the same honesty contract: `ok`
// answers "did the READ succeed", never "were there sweeps"; a payload whose `editions` is not an array
// is a failed read, not an empty market.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { HOT_FLOORS_TIMEOUT_MS } from "@/lib/hot-floors/fetchers"

/**
 * Seven days, not Top Shot's three: All Day's market is a fraction of Top Shot's (2,870 market sales in the
 * 7 days to 2026-10-26), and a 3-day window halves an already short board.
 */
export const ALLDAY_HOT_FLOORS_DAYS = 7

export interface AllDayHotEdition {
  external_id: string
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  sweep_buyers: number
  swept_sales: number
  swept_spend: number | null
  last_swept_at: string | null
  floor_ask: number | null
  /** When the floor listing was last verified on chain (V2 every 2 h, V1 weekly) — a CHECKED stamp. */
  floor_ask_verified_at: string | null
  fmv_usd: number | null
}

export interface AllDayHotFloorsResult {
  editions: AllDayHotEdition[]
  ok: boolean
  /** Newest All Day market sale in the last 30 days — how current "the last N days" is. */
  newestSaleAt: string | null
  /** When the board was computed (the 15-minute snapshot), or null for a live computation. */
  computedAt: string | null
}

export async function fetchAllDayHotFloors(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
  timeoutMs: number = HOT_FLOORS_TIMEOUT_MS,
): Promise<AllDayHotFloorsResult> {
  const failed: AllDayHotFloorsResult = { editions: [], ok: false, newestSaleAt: null, computedAt: null }
  // 2026-10-26: read the 15-minute snapshot (pg_cron allday-hot-floors-snapshot) — one primary-key row. The
  // first cold renders of the live sessionizing read hit the 8 s bound (daytime monitor, 10-27 03:09Z). Only
  // when NO snapshot exists yet does the page compute live; a FAILED snapshot read is a failed read.
  try {
    const snap = await withBoardBudget<{
      data: Array<{ payload: { editions?: unknown; newest_sale_at?: unknown } | null; computed_at: string | null }> | null
      error: { message: string } | null
    }>(db.from("allday_hot_floors_snapshot").select("payload, computed_at").eq("id", 1).limit(1), "allday-hot-floors-snapshot", 3_000, "collection/")
    if (snap.error) {
      console.error("[allday-hot-floors] snapshot read error:", snap.error.message)
      return failed
    }
    const row = Array.isArray(snap.data) ? snap.data[0] : null
    if (row?.payload) {
      const rows = row.payload.editions
      if (!Array.isArray(rows)) {
        console.error("[allday-hot-floors] snapshot payload shape")
        return failed
      }
      return {
        editions: rows as AllDayHotEdition[],
        ok: true,
        newestSaleAt: typeof row.payload.newest_sale_at === "string" ? row.payload.newest_sale_at : null,
        computedAt: row.computed_at ?? null,
      }
    }
  } catch (e) {
    console.error("[allday-hot-floors] snapshot read bound:", e instanceof Error ? e.message : e)
    return failed
  }
  try {
    const { data, error } = await withBoardBudget<{
      data: { editions?: unknown; newest_sale_at?: unknown } | null
      error: { message: string } | null
    }>(db.rpc("get_allday_hot_floors", { p_days: ALLDAY_HOT_FLOORS_DAYS }), "allday-hot-floors", timeoutMs, "collection/")
    if (error) {
      console.error("[allday-hot-floors] read error:", error.message)
      return failed
    }
    const rows = data?.editions
    if (rows == null || !Array.isArray(rows)) {
      console.error("[allday-hot-floors] unexpected payload shape")
      return failed
    }
    return {
      editions: rows as AllDayHotEdition[],
      ok: true,
      newestSaleAt: typeof data?.newest_sale_at === "string" ? data.newest_sale_at : null,
      computedAt: null,
    }
  } catch (e) {
    console.error("[allday-hot-floors] read bound:", e instanceof Error ? e.message : e)
    return failed
  }
}
