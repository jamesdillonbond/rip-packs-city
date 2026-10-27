// lib/candy/edition-market-history.ts
//
// Candy MLB (Top Shot parity, 2026-10-26): an edition's daily market record —
// confirmed floor ask, listed copies and best bid — from candy_edition_market_daily
// (one row per edition per PT day, forward only from Oct 26; a day the listings book
// was not re-read has no row). Candy has had no recorded sale since Oct 11 (#58), so
// its sales-driven chart is flat while asks and bids still move; this is the record
// of those moves. ok:false = the read failed (rendered as such, never "no history").

import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"

/** The PT day the lane's first row was recorded. */
export const CANDY_MARKET_HISTORY_SINCE = "2026-10-26"

export interface CandyMarketDay {
  day: string
  floorAskUsd: number | null
  listedCount: number
  bestOfferUsd: number | null
  offerCount: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any
type HistRows = Array<Record<string, unknown>>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function fetchCandyMarketHistory(
  editionId: string,
  days = 60,
  injected?: Db,
): Promise<{ ok: boolean; rows: CandyMarketDay[] }> {
  const db: Db = injected ?? supabaseAdmin
  try {
    const { data, error } = await withQueryDeadline<HistRows>(
      db.rpc("get_candy_edition_market_history", { p_edition_id: editionId, p_days: days }),
      "edition/candy-market-history",
      apiReadTimeoutMs(),
    )
    if (error) return { ok: false, rows: [] }
    const rows = (Array.isArray(data) ? data : [])
      .filter((r) => typeof r.day === "string")
      .map((r) => ({
        day: r.day as string,
        floorAskUsd: num(r.floor_ask_usd),
        listedCount: num(r.listed_count) ?? 0,
        bestOfferUsd: num(r.best_offer_usd),
        offerCount: num(r.offer_count) ?? 0,
      }))
    return { ok: true, rows }
  } catch {
    return { ok: false, rows: [] }
  }
}

// ── Scarcity row (the edition page's "Featured in Insights" chips) ──────────

type ScarcityRows = Array<{ holders: unknown; circulating: unknown }>

/** This edition's row of mv_candy_scarcity_board (the /insights/candy-mlb Scarcity view's source). */
export async function fetchCandyScarcityRow(
  externalId: string,
  injected?: Db,
): Promise<{ ok: boolean; row: { holders: number | null; circulating: number | null } | null }> {
  const db: Db = injected ?? supabaseAdmin
  try {
    const { data, error } = await withQueryDeadline<ScarcityRows>(
      db.from("mv_candy_scarcity_board").select("holders,circulating").eq("external_id", externalId).limit(1),
      "edition/candy-scarcity-row",
      apiReadTimeoutMs(),
    )
    if (error) return { ok: false, row: null }
    const r = (data ?? [])[0]
    return { ok: true, row: r ? { holders: num(r.holders), circulating: num(r.circulating) } : null }
  } catch {
    return { ok: false, row: null }
  }
}
