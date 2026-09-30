// lib/panini/set-sales.ts
//
// A Panini set's sales, for the set page (2026-09-30), from panini_set_sales (migration
// 20260930170758) over panini_sales. Server only.
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · "Top", "recent" and the 30-day summary are among the sales RPC HOLDS; the payload says how
//     many of the set's editions have their sales fully on record, so the page can say how
//     complete they are and read the 30-day counts as "at least".
//   · A failed or malformed read is null everywhere — never "no sales". A row missing its price,
//     date or edition is dropped, never shown as $0.

import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"
import { serialOfSku } from "@/lib/panini/edition-market"

const LIST = 10

export interface PaniniSetSale {
  editionKey: string
  playerName: string | null
  serial: number | null
  mintCap: number | null
  amountUsd: number
  soldAt: string
}

export interface PaniniSetSales {
  top: PaniniSetSale[]
  recent: PaniniSetSale[]
  editions: number
  /** Editions whose sales are fully on record (whole history, or complete since a moment). */
  editionsRead: number
  window30d: { sales: number; volumeUsd: number | null; medianUsd: number | null; editionsTraded: number }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)

export function parsePaniniSetSales(raw: unknown): PaniniSetSales | null {
  const r = Array.isArray(raw) ? raw[0] : raw
  if (!r || typeof r !== "object") return null
  const o = r as Record<string, unknown>
  const editions = num(o.editions), editionsRead = num(o.editions_read)
  const w = o.window_30d as Record<string, unknown> | null | undefined
  if (editions === null || editionsRead === null || !w || typeof w !== "object" || !Array.isArray(o.top) || !Array.isArray(o.recent)) return null
  const wSales = num(w.sales), wEds = num(w.editions_traded)
  if (wSales === null || wEds === null) return null
  const sale = (x: unknown): PaniniSetSale | null => {
    if (!x || typeof x !== "object") return null
    const s = x as Record<string, unknown>
    const sku = str(s.sku), key = str(s.edition_external_id), at = str(s.sold_at), amount = num(s.amount_usd)
    if (!sku || !key || !at || amount === null) return null
    return { editionKey: key, playerName: str(s.player_name), ...serialOfSku(sku), amountUsd: amount, soldAt: at }
  }
  const keep = (xs: unknown[]) => xs.map(sale).filter((x): x is PaniniSetSale => x !== null)
  return {
    top: keep(o.top as unknown[]),
    recent: keep(o.recent as unknown[]),
    editions,
    editionsRead,
    window30d: { sales: wSales, volumeUsd: num(w.volume_usd), medianUsd: num(w.median_usd), editionsTraded: wEds },
  }
}

/** null = the read failed or came back malformed (the page says so; it never says "no sales"). */
export async function fetchPaniniSetSales(
  setNames: string[],
  db: any = supabaseAdmin, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<PaniniSetSales | null> {
  const names = setNames.filter((n) => typeof n === "string" && n.trim())
  if (names.length === 0) return null
  try {
    const { data, error } = await withQueryDeadline<unknown>(
      db.rpc("panini_set_sales", { p_set_names: names, p_limit: LIST }),
      "set/panini-sales",
      apiReadTimeoutMs(),
    )
    if (error) return null
    return parsePaniniSetSales(data)
  } catch {
    return null
  }
}
