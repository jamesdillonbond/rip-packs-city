// Core FMV price-math primitives, lifted verbatim out of app/api/fmv-recalc/route.ts
// so they can be unit-tested (the route body is a 1,900-line ops handler that can't
// be driven cleanly). These functions decide the DISPLAYED fair-market value of every
// edition — a regression here mis-prices the whole platform — yet they are pure and
// deterministic, so every branch is worth pinning. No I/O, no globals.

// WAP outlier/decay + serial-premium tuning constants (values verbatim from the route).
export const GRAIL_SERIAL_MAX = 10
export const TYPICAL_SERIAL_MIN = 3 // need >= 3 typical sales to base FMV on them
export const LOW_SERIAL_FLOOR_ABS = 15 // serials 1..15 are premium regardless of circ
export const LOW_SERIAL_PCT = 0.1 // ...plus the bottom 10% of the print run
export const LOW_SERIAL_CAP_PCT = 0.25 // ...but never call more than the bottom 25% "premium-low"

export interface DatedSale {
  price: number
  soldAt: Date
}

export interface SerialSale {
  price: number
  soldAt: Date
  serial: number | null
}

// 10%-trimmed median; for <=2 prices falls back to the plain median.
export function trimmedMedian(prices: number[]): number {
  if (prices.length === 0) return 0
  if (prices.length <= 2) {
    const sorted = [...prices].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  }

  const sorted = [...prices].sort((a, b) => a - b)
  const trimCount = Math.max(1, Math.floor(sorted.length * 0.1))
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount)

  const mid = Math.floor(trimmed.length / 2)
  return trimmed.length % 2 === 0 ? (trimmed[mid - 1] + trimmed[mid]) / 2 : trimmed[mid]
}

// Recency-weighted average price with tiered decay:
//   0-7 days: weight 3.0, 7-14 days: weight 2.0, 14-30 days: weight 1.0
export function weightedAveragePrice(sales: DatedSale[], now: Date): number {
  if (sales.length === 0) return 0
  let weightedSum = 0
  let totalWeight = 0
  for (const sale of sales) {
    const ageDays = (now.getTime() - sale.soldAt.getTime()) / (1000 * 60 * 60 * 24)
    const weight = ageDays <= 7 ? 3.0 : ageDays <= 14 ? 2.0 : 1.0
    weightedSum += sale.price * weight
    totalWeight += weight
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0
}

// Liquidity rating on a 0–5 scale based on the count of sales in the window.
export function liquidityRating(salesCount: number): number {
  if (salesCount === 0) return 0
  if (salesCount <= 5) return 1
  if (salesCount <= 20) return 2
  if (salesCount <= 50) return 3
  if (salesCount <= 100) return 4
  return 5
}

// LiveToken averageWithoutWackos equivalent: drop sales >5x or <0.2x the median
// price, then run the weighted-average over what's left.
export function wapWithoutOutliers(sales: DatedSale[], now: Date): number {
  if (sales.length === 0) return 0
  const prices = sales.map(s => s.price).sort((a, b) => a - b)
  const mid = Math.floor(prices.length / 2)
  const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid]
  if (median <= 0) return weightedAveragePrice(sales, now)
  const filtered = sales.filter(s => s.price >= median * 0.2 && s.price <= median * 5)
  if (filtered.length === 0) return weightedAveragePrice(sales, now)
  return weightedAveragePrice(filtered, now)
}

// ── Sales-only FMV = median of the N most recent typical sales (1.8.0, 2026-10-03) ──
// Measured OUT OF SAMPLE (register R125; `fmv_sales_backtest()`): against every
// realized Top Shot sale over five PT weeks, the published recency-weighted
// average (wapWithoutOutliers) trailed a plain median of the edition's most
// recent sales in every week — median abs error 14.8–24.8 % vs 12.5–18.4 %, and
// it ran 4–20 % HIGH in a falling market (median published/price 1.045–1.200 vs
// 1.000). The weighted average's lag is structural: a 29-day-old sale still
// carries a third of today's weight, and a mean is pulled by every high print
// the grail guard leaves. The median of the last N sales has an effective
// horizon of hours on a liquid edition and tolerates up to (N-1)/2 bad prints.
// N = 3, 5, 7 and 10 measured identically (13.0 % / ratio 1.000 on 4,194 sales,
// 14 d); 7 is chosen for robustness and because it is the HIGH-confidence sales
// floor, so a HIGH edition's price is the median of its last seven typical sales.
// Fewer than N sales → the median of what there is. `asp_usd` /
// `asp_without_outliers` still publish the two averages so `fmv / asp` stays a
// readable diagnostic of what the change did.
export const FMV_RECENT_SALES_N = 7
// ── 1.8.1 (2026-10-10): the N most recent sales, but only those within
// FMV_RECENT_SPAN_DAYS of the NEWEST one, never fewer than FMV_RECENT_MIN_N.
// On a liquid edition the last seven sales already sit inside a few days, so
// nothing changes there (identical in every backtest cell). On a THIN edition
// the last seven could span months, and the median kept quoting a market that
// had moved: Candy's Murakami Green /15 read $296.56 after prints of 732 → 724
// → 296 → 203 → 194 → 36 over ten weeks. Backtest 2026-10-10 (sales_market, 45 d,
// predicting each sale from the edition's prior sales; editions with < 7 sales
// in the prior 30 d): Top Shot n=1,788 MdAPE 26.9 % → 24.1 %, median
// estimate/price 1.167 → 1.100, within ±25 % 45.9 % → 51.4 %; All Day n=821
// 33.3 % → 32.4 %; liquid editions and Candy unchanged. A plain last-3 median
// scored better still on Top Shot thin (20.0 %) but tolerates one bad print
// where this keeps up to seven, so the time bound was chosen.
export const FMV_RECENT_SPAN_DAYS = 30
export const FMV_RECENT_MIN_N = 3
// The algo_version every fmv-recalc snapshot is stamped with; the OG cards print it.
export const FMV_ALGO_VERSION = "1.8.1"

export function medianOfMostRecent(sales: DatedSale[], n: number): number {
  if (sales.length === 0 || n <= 0) return 0
  const recent = [...sales].sort((a, b) => b.soldAt.getTime() - a.soldAt.getTime()).slice(0, n)
  const newest = recent[0].soldAt.getTime()
  const spanFloor = newest - FMV_RECENT_SPAN_DAYS * 24 * 60 * 60 * 1000
  const bounded = recent.filter((s, i) => i < FMV_RECENT_MIN_N || s.soldAt.getTime() >= spanFloor)
  return medianOf(bounded.map(s => s.price))
}

// Plain median of a price array (no trimming). Returns 0 for an empty array.
export function medianOf(prices: number[]): number {
  if (prices.length === 0) return 0
  const s = [...prices].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

// Circulation-scaled low-serial cutoff. For unknown/zero circulation only the
// absolute floor applies (no print run to take a percentage of).
export function lowSerialThreshold(circ: number | null): number {
  if (!circ || circ <= 0) return LOW_SERIAL_FLOOR_ABS
  const band = Math.max(LOW_SERIAL_FLOOR_ABS, Math.ceil(circ * LOW_SERIAL_PCT))
  const cap = Math.max(1, Math.floor(circ * LOW_SERIAL_CAP_PCT))
  return Math.min(band, cap)
}

// True when a sale's serial carries an outsized collector premium and must not
// set the typical-serial base. Null serials are treated as typical (kept).
export function isPremiumSerial(serial: number | null, circ: number | null, jersey: number | null): boolean {
  if (serial == null) return false
  if (serial === 1) return true
  if (circ != null && circ > 0 && serial === circ) return true
  if (jersey != null && jersey > 0 && serial === jersey) return true
  return serial <= lowSerialThreshold(circ)
}

// Thin-window grail guard (audit 2026-06-09 — the "$9,000 S1 Jokić" class).
// Removes grail-serial / fat-finger spikes before WAP/median so the published FMV
// reflects the real market. capValue = 3x the survivor median; the caller applies
// it only when the cleaned set is too thin (< 2 sales) to trust the raw WAP.
//
// Every step here targets the HIGH side. There is deliberately NO absolute low-price
// floor: the 2026-08-02 audit (docs/fmv-dust-filter-decision-2026-08-02.md) removed a
// `price >= $0.50` drop that ran here as step 1. It discarded 46% of Top Shot and 76%
// of All Day 30d transactions — the real bottom of both order books, not noise (1,094
// distinct TS buyers below $0.50 in 30d, zero self-trades, and a price histogram that
// is continuous straight through the cut, whose mode is the $0.25 marketplace minimum)
// — and inflated published FMV to 1.55x (partially cut) / 2.28x (fully cut) the
// edition's own realized median, against 1.03x where it happened not to bite. The
// downside protection it was assumed to provide already exists in wapWithoutOutliers'
// 0.2x-median relative band; the high side is covered by steps 1-3 below. Do not
// reintroduce an absolute floor here — use a relative one if it is ever needed.
export function dampenGrailSpike(
  sales: SerialSale[],
  opts: { isCommonish: boolean },
): { cleaned: SerialSale[]; capValue: number } {
  let cleaned = sales.slice()
  if (cleaned.length <= 1) {
    const m = medianOf(cleaned.map(s => s.price))
    return { cleaned, capValue: m > 0 ? m * 3 : 0 }
  }

  // 1. Low-serial grail removal.
  for (let guard = 0; guard < 5 && cleaned.length >= 2; guard++) {
    let maxIdx = 0
    for (let i = 1; i < cleaned.length; i++) if (cleaned[i].price > cleaned[maxIdx].price) maxIdx = i
    const top = cleaned[maxIdx]
    const rest = cleaned.filter((_, i) => i !== maxIdx)
    const restMedian = medianOf(rest.map(s => s.price))
    if (top.serial != null && top.serial <= GRAIL_SERIAL_MAX && restMedian > 0 && top.price > restMedian * 3) {
      cleaned = rest
    } else {
      break
    }
  }

  // 2. Generic high-outlier removal with >= 3 corroborating normal sales.
  {
    const survivorMedian = medianOf(cleaned.map(s => s.price))
    if (survivorMedian > 0) {
      const normal = cleaned.filter(s => s.price <= survivorMedian * 5)
      if (normal.length >= 3 && normal.length < cleaned.length) cleaned = normal
    }
  }

  // 3. Commonish-tier thin-window safeguard.
  if (opts.isCommonish && cleaned.length >= 2 && cleaned.length <= 4) {
    const asc = [...cleaned].sort((a, b) => a.price - b.price)
    const lo = asc[0].price
    const hi = asc[asc.length - 1].price
    if (lo > 0 && hi > lo * 5) cleaned = asc.slice(0, asc.length - 1)
  }

  const finalMedian = medianOf(cleaned.map(s => s.price))
  return { cleaned, capValue: finalMedian > 0 ? finalMedian * 3 : 0 }
}
