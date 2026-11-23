/**
 * Physical cards — value range from confirmed sold sales (prototype, NOT wired).
 *
 * Scoping doc: "Physical Cards on RPC — Scoping" (claude.ai artifact). This is
 * the same rule set RPC uses for digital FMV, mapped onto paper cards:
 *
 *   1. Confirmed paid prices only. A Best Offer sale whose reported price is
 *      >= its asking price is almost certainly the ASK (eBay hides accepted
 *      offers), so it is dropped, never trusted.
 *   2. One exact grader + grade. A PSA 10 is never priced from BGS 9.5 or raw
 *      sales — prices are never borrowed across graders or grades.
 *   3. Median of the most recent sales inside a window, not a mean.
 *   4. Shill / fat-finger guard: sales outside [median/3, median*3] of the
 *      window are excluded before the final median.
 *   5. STALE cap: when the newest sale is older than `staleDays`, the point
 *      value is capped at that last sale (the #209 lesson — a stale value ran
 *      2–5x realised sales on Top Shot / All Day).
 *   6. `internalConfidence` is INTERNAL ONLY (standing rule 2026-10-18). Never
 *      render it; the UI shows the range and the source.
 *
 * Pure: no I/O, no clock reads (pass `asOf`).
 */

export type Grader = "psa" | "bgs" | "cgc" | "sgc" | "raw"

export type SaleType = "auction" | "buy_it_now" | "best_offer" | null

export type PhysicalSale = {
  soldAt: string // ISO timestamp
  price: number // USD
  grader: Grader
  grade: string // "10", "9.5", "raw" …
  saleType?: SaleType
  askingPrice?: number | null
  source?: string | null // marketplace name, kept for provenance
  url?: string | null
}

export type RangeOptions = {
  asOf: string // ISO timestamp — the "now" of the estimate
  windowDays?: number // default 90
  maxSales?: number // most recent N used, default 10
  minSales?: number // below this, no value is published, default 3
  staleDays?: number // default 30
  outlierFactor?: number // default 3
}

export type ValueRange = {
  status: "ok" | "insufficient"
  grader: Grader
  grade: string
  low: number | null
  point: number | null
  high: number | null
  salesUsed: number
  newestSaleAt: string | null
  stale: boolean
  /** Which rule shaped the number, for the backtest log — not for display. */
  notes: string[]
  /** INTERNAL ONLY — never rendered (rpc-fmv-confidence-is-internal-only). */
  internalConfidence: "high" | "medium" | "low" | null
}

const DAY_MS = 86_400_000

export function normalizeGrade(grade: string): string {
  const g = String(grade).trim().toLowerCase()
  if (g === "" || g === "raw" || g === "ungraded") return "raw"
  const n = Number(g)
  return Number.isFinite(n) ? String(n) : g
}

/** Rule 1: drop sales that are not confirmed paid prices. */
export function isConfirmedPaid(s: PhysicalSale): boolean {
  if (!Number.isFinite(s.price) || s.price <= 0) return false
  if (s.saleType === "best_offer") {
    if (s.askingPrice == null) return false
    if (s.price >= s.askingPrice) return false
  }
  return true
}

export function median(values: number[]): number {
  const a = [...values].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

/** Linear-interpolated quantile, q in [0,1]. */
export function quantile(values: number[], q: number): number {
  const a = [...values].sort((x, y) => x - y)
  if (a.length === 1) return a[0]
  const pos = (a.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return a[lo] + (a[hi] - a[lo]) * (pos - lo)
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function valueRange(
  sales: PhysicalSale[],
  grader: Grader,
  grade: string,
  opts: RangeOptions,
): ValueRange {
  const windowDays = opts.windowDays ?? 90
  const maxSales = opts.maxSales ?? 10
  const minSales = opts.minSales ?? 3
  const staleDays = opts.staleDays ?? 30
  const outlierFactor = opts.outlierFactor === undefined ? 3 : opts.outlierFactor
  const asOfMs = Date.parse(opts.asOf)
  const g = normalizeGrade(grade)
  const notes: string[] = []

  const empty = (why: string): ValueRange => ({
    status: "insufficient",
    grader,
    grade: g,
    low: null,
    point: null,
    high: null,
    salesUsed: 0,
    newestSaleAt: null,
    stale: false,
    notes: [...notes, why],
    internalConfidence: null,
  })

  // Rule 2: exact grader + grade only. Sales after asOf never leak in.
  const matching = sales.filter(
    (s) =>
      s.grader === grader &&
      normalizeGrade(s.grade) === g &&
      Date.parse(s.soldAt) <= asOfMs,
  )
  const paid = matching.filter(isConfirmedPaid)
  if (paid.length < matching.length)
    notes.push(`dropped ${matching.length - paid.length} unconfirmed`)

  const inWindow = paid
    .filter((s) => asOfMs - Date.parse(s.soldAt) <= windowDays * DAY_MS)
    .sort((a, b) => Date.parse(b.soldAt) - Date.parse(a.soldAt))
    .slice(0, maxSales)

  if (inWindow.length < minSales) {
    return empty(`only ${inWindow.length} sales in ${windowDays}d`)
  }

  // Rule 4: outlier guard around the raw median.
  const m0 = median(inWindow.map((s) => s.price))
  const kept = inWindow.filter(
    (s) => s.price <= m0 * outlierFactor && s.price * outlierFactor >= m0,
  )
  if (kept.length < inWindow.length)
    notes.push(`dropped ${inWindow.length - kept.length} outliers`)
  if (kept.length < minSales) return empty("too few after outlier guard")

  const prices = kept.map((s) => s.price)
  let point = median(prices)
  let low = kept.length >= 5 ? quantile(prices, 0.25) : Math.min(...prices)
  let high = kept.length >= 5 ? quantile(prices, 0.75) : Math.max(...prices)

  const newest = kept[0]
  const ageDays = (asOfMs - Date.parse(newest.soldAt)) / DAY_MS
  const stale = ageDays > staleDays
  if (stale && point > newest.price) {
    // Rule 5: last-sale cap.
    point = newest.price
    high = Math.min(high, newest.price)
    low = Math.min(low, point)
    notes.push("stale: capped at last sale")
  }

  const internalConfidence: ValueRange["internalConfidence"] =
    kept.length >= 8 && !stale ? "high" : kept.length >= 5 && !stale ? "medium" : "low"

  return {
    status: "ok",
    grader,
    grade: g,
    low: round2(low),
    point: round2(point),
    high: round2(high),
    salesUsed: kept.length,
    newestSaleAt: newest.soldAt,
    stale,
    notes,
    internalConfidence,
  }
}
