/**
 * Physical cards — walk-forward backtest of valueRange (prototype, NOT wired).
 *
 * For every sale after the first `warmup`, estimate the card's value using
 * ONLY sales strictly before it, then score the estimate against what it
 * actually sold for. This is the gate in the scoping doc: no physical value is
 * shown publicly until this passes on the licensed feed's data.
 *
 * Out-of-sample by construction (the R125 / #209 lessons): the estimate never
 * sees the sale it is scored on or anything after it.
 */
import { valueRange, type Grader, type PhysicalSale, type RangeOptions } from "./valuation-range"

export type BacktestRow = {
  soldAt: string
  actual: number
  point: number
  low: number
  high: number
  absPctError: number
  inRange: boolean
}

export type BacktestSummary = {
  scored: number
  skippedInsufficient: number
  medianAbsPctError: number | null
  within25Pct: number | null // share of estimates within ±25 % of the sale
  rangeCoverage: number | null // share of sales landing inside [low, high]
  rows: BacktestRow[]
}

/** Default pass bar — mirrors the bar we set for digital FMV; tune once real data exists. */
export const DEFAULT_PASS_BAR = { maxMedianAbsPctError: 0.2, minWithin25Pct: 0.6 }

export function backtestCard(
  sales: PhysicalSale[],
  grader: Grader,
  grade: string,
  opts: Omit<RangeOptions, "asOf"> & { warmup?: number } = {},
): BacktestSummary {
  const ordered = [...sales].sort((a, b) => Date.parse(a.soldAt) - Date.parse(b.soldAt))
  const warmup = opts.warmup ?? 3
  const rows: BacktestRow[] = []
  let skipped = 0

  for (let i = warmup; i < ordered.length; i++) {
    const target = ordered[i]
    if (target.grader !== grader) continue
    const before = ordered.filter((s) => Date.parse(s.soldAt) < Date.parse(target.soldAt))
    // asOf one ms before the sale so the sale itself is never visible.
    const asOf = new Date(Date.parse(target.soldAt) - 1).toISOString()
    const r = valueRange(before, grader, grade, { ...opts, asOf })
    if (r.status !== "ok" || r.point == null || r.low == null || r.high == null) {
      skipped++
      continue
    }
    const ape = Math.abs(r.point - target.price) / target.price
    rows.push({
      soldAt: target.soldAt,
      actual: target.price,
      point: r.point,
      low: r.low,
      high: r.high,
      absPctError: ape,
      inRange: target.price >= r.low && target.price <= r.high,
    })
  }

  if (rows.length === 0) {
    return {
      scored: 0,
      skippedInsufficient: skipped,
      medianAbsPctError: null,
      within25Pct: null,
      rangeCoverage: null,
      rows,
    }
  }
  const apes = [...rows.map((r) => r.absPctError)].sort((a, b) => a - b)
  const mid = Math.floor(apes.length / 2)
  return {
    scored: rows.length,
    skippedInsufficient: skipped,
    medianAbsPctError: apes.length % 2 ? apes[mid] : (apes[mid - 1] + apes[mid]) / 2,
    within25Pct: rows.filter((r) => r.absPctError <= 0.25).length / rows.length,
    rangeCoverage: rows.filter((r) => r.inRange).length / rows.length,
    rows,
  }
}

export function passes(
  s: BacktestSummary,
  bar = DEFAULT_PASS_BAR,
): boolean {
  return (
    s.scored > 0 &&
    s.medianAbsPctError != null &&
    s.within25Pct != null &&
    s.medianAbsPctError <= bar.maxMedianAbsPctError &&
    s.within25Pct >= bar.minWithin25Pct
  )
}
