// lib/panini/overview-feeds.ts
//
// The two list panels on /panini-blockchain/overview — "Top 5 Sniper Deals" and
// "Recent Top Sales" — read from Panini's OWN sources (2026-10-14).
//
// Until then lib/collection-stats/read.ts nulled both (get_collection_stats reads
// the Flow feeds, which hold zero Panini rows), and the client turned the null
// deals into `[]` and rendered "No deals ≥15% off right now" while the Sniper tab
// listed ~600, and the sales panel said "Sales aren't a tracked feed for this
// collection yet" while panini_sales held ~588k sales. Both were claims about
// Panini's market manufactured from a gap in OUR wiring.
//
// Sources, chosen for cost (measured 2026-10-14 ~9:10 PM PT):
//   • deals — the first five rows of the hourly `panini-boards` snapshot's
//     `deals_all` (the exact list and order the Sniper tab shows), sliced in the
//     DB by PostgREST JSON paths. Reading panini_deal_board_all live costs
//     ~2.2 s / 168k buffers per call; this is one row of public_board_snapshots.
//   • top sales — v_panini_top_sales (non-trivial sales, ≥ $100, 30 d), last 7 d
//     by price: 0.6 ms / 36 buffers.
//
// Three states each, never two: { ok: true, rows } (rows may be empty — an
// honest market claim within the stated scope) · { ok: false } (the read failed
// or the snapshot is too old to present as current). The caller nulls the field
// and flags `*_failed`; the client renders "couldn't load", never "none".

import { boundedRead } from "@/lib/api/bounded-read"
import { BOARD_SNAPSHOT_STALE_CEILING_MS } from "@/lib/insights/board-cache"
import { paniniEditionUrl } from "@/lib/panini/edition-url"

export const PANINI_OVERVIEW_DEALS = 5
export const PANINI_TOP_SALES_DAYS = 7
/** v_panini_top_sales' own floor — restated so the panel can say what it lists. */
export const PANINI_TOP_SALES_MIN_USD = 100

export interface PaniniOverviewDeal {
  flow_id: string | null
  player_name: string | null
  tier: string | null
  set_name: string | null
  serial_number: number | null
  ask_price: number
  fmv: number | null
  discount: number | null
  buy_url: string | null
}

export interface PaniniOverviewSale {
  edition_name: null
  player_name: string | null
  tier: string | null
  set_name: string | null
  serial_number: number | null
  circulation_count: number | null
  price: number
  sold_at: string
}

export type PaniniFeedRead<T> = { ok: true; rows: T[] } | { ok: false }

const numOrNull = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)

/** The edition key of a serial sku ("<psku>__<serial>_<cap>"), or null. */
export function editionKeyOfSku(sku: unknown): string | null {
  const m = typeof sku === "string" ? /^(.+)__\d+_\d+$/.exec(sku) : null
  return m ? m[1] : null
}

/** One `deals_all` snapshot row → the overview's deal shape; null when it has no usable ask. */
export function parsePaniniDeal(row: unknown): PaniniOverviewDeal | null {
  if (!row || typeof row !== "object") return null
  const r = row as Record<string, unknown>
  const ask = numOrNull(r.ask_usd)
  if (ask == null || ask <= 0) return null
  const ek = editionKeyOfSku(r.sku)
  return {
    flow_id: ek,
    player_name: strOrNull(r.player_name),
    tier: strOrNull(r.tier),
    set_name: strOrNull(r.parallel),
    serial_number: numOrNull(r.serial_number),
    ask_price: ask,
    fmv: numOrNull(r.fmv_usd),
    discount: numOrNull(r.discount_pct),
    buy_url: paniniEditionUrl(ek),
  }
}

/** One v_panini_top_sales row → the overview's sale shape; null without a price or time. */
export function parsePaniniSale(row: unknown): PaniniOverviewSale | null {
  if (!row || typeof row !== "object") return null
  const r = row as Record<string, unknown>
  const price = numOrNull(r.price_usd)
  const soldAt = strOrNull(r.sold_at)
  if (price == null || price <= 0 || !soldAt) return null
  return {
    edition_name: null,
    player_name: strOrNull(r.player_name),
    tier: strOrNull(r.tier),
    set_name: strOrNull(r.set_name),
    serial_number: numOrNull(r.serial_number),
    circulation_count: numOrNull(r.circulation_count),
    price,
    sold_at: soldAt,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPaniniOverviewDeals(db: any, where: string, nowMs: number = Date.now()): Promise<PaniniFeedRead<PaniniOverviewDeal>> {
  try {
    const slices = Array.from({ length: PANINI_OVERVIEW_DEALS }, (_, i) => `d${i}:payload->deals_all->${i}`).join(",")
    const { data, error } = await boundedRead(
      db.from("public_board_snapshots").select(`refreshed_at,${slices}`).eq("board_key", "panini-boards").limit(1),
      where,
    )
    if (error) {
      console.log(`[${where}] panini overview deals read failed: ${error.message ?? error}`)
      return { ok: false }
    }
    const row = (data ?? [])[0] as Record<string, unknown> | undefined
    const refreshedMs = row ? Date.parse(String(row.refreshed_at ?? "")) : NaN
    // No snapshot, or one too old to present as "right now": not a measurement.
    if (!row || !Number.isFinite(refreshedMs) || nowMs - refreshedMs > BOARD_SNAPSHOT_STALE_CEILING_MS) return { ok: false }
    const rows: PaniniOverviewDeal[] = []
    for (let i = 0; i < PANINI_OVERVIEW_DEALS; i++) {
      const d = parsePaniniDeal(row[`d${i}`])
      if (d) rows.push(d)
    }
    return { ok: true, rows }
  } catch (err) {
    console.log(`[${where}] panini overview deals read threw: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPaniniTopSales(db: any, where: string, nowMs: number = Date.now()): Promise<PaniniFeedRead<PaniniOverviewSale>> {
  try {
    const since = new Date(nowMs - PANINI_TOP_SALES_DAYS * 86_400_000).toISOString()
    const { data, error } = await boundedRead(
      db.from("v_panini_top_sales")
        .select("player_name,set_name,tier,serial_number,circulation_count,price_usd,sold_at")
        .gte("sold_at", since)
        .order("price_usd", { ascending: false })
        .order("sold_at", { ascending: false })
        .limit(5),
      where,
    )
    if (error) {
      console.log(`[${where}] panini top sales read failed: ${error.message ?? error}`)
      return { ok: false }
    }
    return { ok: true, rows: ((data ?? []) as unknown[]).map(parsePaniniSale).filter(Boolean) as PaniniOverviewSale[] }
  } catch (err) {
    console.log(`[${where}] panini top sales read threw: ${err instanceof Error ? err.message : String(err)}`)
    return { ok: false }
  }
}
