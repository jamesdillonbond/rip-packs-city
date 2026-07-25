// Core FMV price-math primitives, lifted verbatim out of app/api/fmv-recalc/route.ts
// so they can be unit-tested (the route body is a 1,900-line ops handler that can't
// be driven cleanly). These functions decide the DISPLAYED fair-market value of every
// edition — a regression here mis-prices the whole platform — yet they are pure and
// deterministic, so every branch is worth pinning. No I/O, no globals.

// WAP outlier/decay + serial-premium tuning constants (values verbatim from the route).
export const DUST_PRICE_USD = 0.5
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
export function dampenGrailSpike(
  sales: SerialSale[],
  opts: { isCommonish: boolean },
): { cleaned: SerialSale[]; capValue: number } {
  let cleaned = sales.filter(s => s.price >= DUST_PRICE_USD)
  if (cleaned.length <= 1) {
    const m = medianOf(cleaned.map(s => s.price))
    return { cleaned, capValue: m > 0 ? m * 3 : 0 }
  }

  // 2. Low-serial grail removal.
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

  // 3. Generic high-outlier removal with >= 3 corroborating normal sales.
  {
    const survivorMedian = medianOf(cleaned.map(s => s.price))
    if (survivorMedian > 0) {
      const normal = cleaned.filter(s => s.price <= survivorMedian * 5)
      if (normal.length >= 3 && normal.length < cleaned.length) cleaned = normal
    }
  }

  // 4. Commonish-tier thin-window safeguard.
  if (opts.isCommonish && cleaned.length >= 2 && cleaned.length <= 4) {
    const asc = [...cleaned].sort((a, b) => a.price - b.price)
    const lo = asc[0].price
    const hi = asc[asc.length - 1].price
    if (lo > 0 && hi > lo * 5) cleaned = asc.slice(0, asc.length - 1)
  }

  const finalMedian = medianOf(cleaned.map(s => s.price))
  return { cleaned, capValue: finalMedian > 0 ? finalMedian * 3 : 0 }
}
