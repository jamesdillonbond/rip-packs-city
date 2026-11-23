/**
 * Re-price planned cards from the feed and produce cache rows
 * (prototype, NOT wired; no scheduler calls it).
 *
 * One /sales call per card returns every grade, so each card yields one row
 * per (grader, grade) seen in its sales — including "insufficient" grades,
 * which are NOT written (a missing row means "unpriced", the honest state).
 *
 * Dependencies are injected so the job can run from a route, a script or a
 * test without touching Supabase here.
 */
import { valueRange, normalizeGrade, type PhysicalSale } from "./valuation-range"
import type { HciResult } from "./hci-client"

export type CacheRow = {
  card_id: string
  grader: string
  grade: string
  low_usd: number
  point_usd: number
  high_usd: number
  sales_used: number
  newest_sale_at: string | null
  stale: boolean
  internal_confidence: string | null
  source: string
  computed_at: string
}

export type RefreshDeps = {
  /** HCI card id for an RPC physical_cards.id */
  sourceIdFor: (cardId: string) => string
  fetchSales: (sourceCardId: string) => Promise<HciResult<PhysicalSale[]>>
  upsert: (rows: CacheRow[]) => Promise<{ ok: boolean }>
}

export type RefreshReport = {
  cards: number
  rowsWritten: number
  failedCards: string[]
  lookupsSpent: number
  stoppedOnRateLimit: boolean
}

export async function refreshValues(cardIds: string[], deps: RefreshDeps, asOf: string): Promise<RefreshReport> {
  const report: RefreshReport = { cards: 0, rowsWritten: 0, failedCards: [], lookupsSpent: 0, stoppedOnRateLimit: false }
  for (const cardId of cardIds) {
    const r = await deps.fetchSales(deps.sourceIdFor(cardId))
    report.lookupsSpent++
    if (!r.ok) {
      report.failedCards.push(cardId)
      // 429 = the key's limit; continuing would only spend more refusals.
      if (r.status === 429) {
        report.stoppedOnRateLimit = true
        break
      }
      continue
    }
    report.cards++
    const groups = new Set(r.data.map((s) => `${s.grader}|${normalizeGrade(s.grade)}`))
    const rows: CacheRow[] = []
    for (const g of groups) {
      const [grader, grade] = g.split("|")
      const v = valueRange(r.data, grader as PhysicalSale["grader"], grade, { asOf })
      if (v.status !== "ok" || v.low == null || v.point == null || v.high == null) continue
      rows.push({
        card_id: cardId,
        grader,
        grade,
        low_usd: v.low,
        point_usd: v.point,
        high_usd: v.high,
        sales_used: v.salesUsed,
        newest_sale_at: v.newestSaleAt,
        stale: v.stale,
        internal_confidence: v.internalConfidence,
        source: "HobbyCardIndex",
        computed_at: asOf,
      })
    }
    if (rows.length) {
      const w = await deps.upsert(rows)
      if (w.ok) report.rowsWritten += rows.length
      else report.failedCards.push(cardId)
    }
  }
  return report
}
