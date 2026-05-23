// lib/fmv-confidence.ts
//
// Canonical FMV confidence-tier logic — the single source of truth shared by
// the fmv-recalc and fmv-backfill routes. Extracted 2026-05-20 (audit F11):
// the two routes kept their own copies and had drifted (recalc gated HIGH at
// >=10 sales, backfill at >=5), producing inconsistent labels.
//
//   HIGH   = >= MIN_SALES_30D_HIGH sales in window AND price dispersion
//            below HIGH_MAX_DISPERSION
//   MEDIUM = >= MIN_SALES_30D_MEDIUM sales, but not HIGH
//   LOW    = everything else
//
// Dispersion gate (2026-05-23): the HIGH gate measures price dispersion AFTER
// removing the serial-number effect. A serially-numbered moment's #1 and
// #25000 legitimately trade many multiples apart, so raw price spread is not
// pricing noise — it is expected structure. escalateConfidence() fits
// ln(price) = a + b*ln(serial) per edition and gates HIGH on the residual
// spread. Modelled against production sales (2026-05-23): this lifts
// HIGH-eligible editions from ~900 to ~1,260 with only ~21 demotions, because
// the fit is self-calibrating per edition rather than relying on a global
// serial-premium model. When serials are unavailable for an edition the gate
// falls back to the raw coefficient of variation, so behaviour is unchanged
// for callers that do not supply serials.

export type FmvConfidence = "HIGH" | "MEDIUM" | "LOW"

export const MIN_SALES_30D_HIGH = 7
export const MIN_SALES_30D_MEDIUM = 5
// Max dispersion allowed for a HIGH rating. Applied to the serial-residual
// log-dispersion when serials are available, otherwise to the raw coefficient
// of variation (stddev / mean). The two measures are close in scale — a raw CV
// of 0.40 corresponds to a log-sd of ~0.385 — so one threshold serves both.
export const HIGH_MAX_DISPERSION = 0.4

// Volume-only base tier. HIGH is deliberately never assigned here — it requires
// the dispersion gate in escalateConfidence().
export function computeConfidence(salesCount: number): FmvConfidence {
  if (salesCount >= MIN_SALES_30D_MEDIUM) return "MEDIUM"
  return "LOW"
}

// Raw coefficient of variation (stddev / mean) of a price set. Returns
// Infinity when the set is empty or the mean is non-positive, so the caller
// never promotes such an edition to HIGH.
function coefficientOfVariation(prices: number[]): number {
  if (prices.length === 0) return Infinity
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length
  if (mean <= 0) return Infinity
  const variance =
    prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length
  return Math.sqrt(variance) / mean
}

// Residual price dispersion after removing the serial-number effect.
// Fits ln(price) = a + b*ln(serial) by ordinary least squares over the sales
// that carry a usable serial, then returns the standard deviation of the
// residuals in log space. A low value means: once serial is accounted for, the
// edition's sales agree — so any serial of it can be priced confidently.
// Returns null when fewer than MIN_SALES_30D_HIGH sales have a usable serial,
// which signals the caller to fall back to the raw coefficient of variation.
export function serialResidualDispersion(
  prices: number[],
  serials: (number | null | undefined)[],
): number | null {
  const xs: number[] = []
  const ys: number[] = []
  const n = Math.min(prices.length, serials.length)
  for (let i = 0; i < n; i++) {
    const p = prices[i]
    const s = Number(serials[i])
    if (p > 0 && Number.isFinite(s) && s > 0) {
      xs.push(Math.log(s))
      ys.push(Math.log(p))
    }
  }
  const m = ys.length
  if (m < MIN_SALES_30D_HIGH) return null

  const meanX = xs.reduce((a, b) => a + b, 0) / m
  const meanY = ys.reduce((a, b) => a + b, 0) / m
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < m; i++) {
    const dx = xs[i] - meanX
    sxx += dx * dx
    sxy += dx * (ys[i] - meanY)
  }
  // slope is 0 when every sale shares one serial (no x variance) — the residual
  // then equals the plain log-price dispersion, which is the correct fallback.
  const slope = sxx > 0 ? sxy / sxx : 0
  const intercept = meanY - slope * meanX

  let ssr = 0
  for (let i = 0; i < m; i++) {
    const resid = ys[i] - (intercept + slope * xs[i])
    ssr += resid * resid
  }
  return Math.sqrt(ssr / m)
}

// Refine the base tier. Promotes to HIGH only when the volume gate is met AND
// dispersion is tight. Pass `serials` (parallel to `prices`, one entry per
// sale) to use the serial-residual gate; omit it to use the raw coefficient of
// variation. Editions with enough sales but dispersed prices stay MEDIUM.
export function escalateConfidence(
  base: FmvConfidence,
  salesCount30d: number,
  prices: number[],
  serials?: (number | null | undefined)[],
): FmvConfidence {
  let confidence = base

  if (confidence === "LOW" && salesCount30d >= MIN_SALES_30D_MEDIUM) {
    confidence = "MEDIUM"
  }

  if (
    confidence !== "HIGH" &&
    salesCount30d >= MIN_SALES_30D_HIGH &&
    prices.length >= MIN_SALES_30D_HIGH
  ) {
    // Prefer the serial-residual dispersion; fall back to raw CV when serials
    // are not supplied or too few sales carry one.
    let dispersion: number | null = null
    if (serials && serials.length === prices.length) {
      dispersion = serialResidualDispersion(prices, serials)
    }
    if (dispersion === null) {
      dispersion = coefficientOfVariation(prices)
    }
    if (dispersion < HIGH_MAX_DISPERSION) {
      confidence = "HIGH"
    }
  }

  return confidence
}
