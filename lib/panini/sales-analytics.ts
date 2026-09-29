// lib/panini/sales-analytics.ts
//
// Parser for panini_sales_analytics (migration 20260929023845). Pure and client-safe. A payload
// missing its coverage block, its daily series or its window is REJECTED (null) so the tab says
// "couldn't load" instead of rendering zeros; a missing number inside a row is null, never 0.

import type { PaniniSalesAnalytics, PaniniDay, PaniniSaleRow, PaniniTradedRow, PaniniGroupRow } from "@/components/collection/PaniniAnalytics"

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : [])

export function parsePaniniSalesAnalytics(raw: unknown): PaniniSalesAnalytics | null {
  const r = Array.isArray(raw) ? raw[0] : raw
  if (!r || typeof r !== "object") return null
  const o = r as Record<string, unknown>
  const c = o.coverage as Record<string, unknown> | undefined
  const w = o.window as Record<string, unknown> | undefined
  if (!c || typeof c !== "object" || !w || typeof w !== "object" || !Array.isArray(o.daily)) return null
  const cov = {
    active_editions: num(c.active_editions),
    editions_read: num(c.editions_read),
    editions_whole_history: num(c.editions_whole_history),
    editions_with_gaps: num(c.editions_with_gaps),
    sales_held: num(c.sales_held),
    sales_from_full_records: num(c.sales_from_full_records),
  }
  if (Object.values(cov).some((v) => v === null)) return null
  const winSales = num(w.sales)
  const winEds = num(w.editions_traded)
  const winCards = num(w.cards_traded)
  const days = num(o.days)
  if (winSales === null || winEds === null || winCards === null || days === null) return null
  const daily: PaniniDay[] = []
  for (const d of arr(o.daily)) {
    const day = str(d.day)
    const sales = num(d.sales)
    if (!day || sales === null) return null
    daily.push({ day, sales, volume_usd: num(d.volume_usd), median_usd: num(d.median_usd), covered_pct: num(d.covered_pct) })
  }
  const sale = (x: Record<string, unknown>): PaniniSaleRow | null => {
    const sku = str(x.sku), ed = str(x.edition_external_id), at = str(x.sold_at), amt = num(x.amount_usd)
    if (!sku || !ed || !at || amt === null) return null
    return { sku, edition_external_id: ed, sold_at: at, amount_usd: amt, player_name: str(x.player_name), set_name: str(x.set_name), tier: str(x.tier), serial_number: num(x.serial_number), mint_cap: num(x.mint_cap) }
  }
  const traded = (x: Record<string, unknown>): PaniniTradedRow | null => {
    const ed = str(x.edition_external_id), n = num(x.sales)
    if (!ed || n === null) return null
    return { edition_external_id: ed, player_name: str(x.player_name), set_name: str(x.set_name), tier: str(x.tier), sales: n, volume_usd: num(x.volume_usd), median_usd: num(x.median_usd) }
  }
  const group = (key: "tier" | "parallel") => (x: Record<string, unknown>): PaniniGroupRow | null => {
    const k = str(x[key]), n = num(x.sales)
    if (!k || n === null) return null
    return { [key]: k, sales: n, volume_usd: num(x.volume_usd), median_usd: num(x.median_usd) }
  }
  const keep = <T,>(xs: (T | null)[]) => xs.filter((x): x is T => x !== null)
  return {
    generated_at: str(o.generated_at),
    days,
    coverage: {
      ...(cov as { [K in keyof typeof cov]: number }),
      first_read_at: str(c.first_read_at),
      last_read_at: str(c.last_read_at),
    },
    daily,
    window: { sales: winSales, volume_usd: num(w.volume_usd), median_usd: num(w.median_usd), editions_traded: winEds, cards_traded: winCards },
    top_sales_window: keep(arr(o.top_sales_window).map(sale)),
    top_sales_all_time: keep(arr(o.top_sales_all_time).map(sale)),
    most_traded: keep(arr(o.most_traded).map(traded)),
    by_tier: keep(arr(o.by_tier).map(group("tier"))),
    by_parallel: keep(arr(o.by_parallel).map(group("parallel"))),
  }
}
