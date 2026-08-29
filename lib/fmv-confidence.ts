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
// spread. The fit is self-calibrating per edition rather than relying on a
// global serial-premium model. When serials are unavailable the gate falls
// back to the raw coefficient of variation, so behaviour is unchanged for
// callers that do not supply serials.
//
// Thresholds tuned 2026-05-24: against the 2,997 well-traded LOW/SALES_ONLY
// editions, the serial-residual SD has two natural breakpoints — 1,737 clear
// 0.20 (HIGH) and 2,476 clear 0.35 (HIGH + MEDIUM combined). HIGH now gates
// on 0.20 (was 0.40, too loose). MEDIUM gets a dispersion ceiling at 0.35
// that only applies once we have enough sales for a reliable fit
// (count >= MIN_SALES_30D_HIGH). Below that count the volume floor still
// grants MEDIUM, since the fit is not yet trustworthy enough to demote on.

export type FmvConfidence = "HIGH" | "MEDIUM" | "LOW"

export const MIN_SALES_30D_HIGH = 7
export const MIN_SALES_30D_MEDIUM = 5
// Max dispersion allowed for a HIGH rating. Applied to the serial-residual
// log-dispersion when serials are available, otherwise to the raw coefficient
// of variation (stddev / mean).
export const HIGH_MAX_DISPERSION = 0.2
// Max dispersion that confirms a MEDIUM rating on the same residual scale.
// Editions with count >= 7 and residual between HIGH and MEDIUM bounds land
// at MEDIUM. Above this bound, MEDIUM is held only by the volume floor.
export const MEDIUM_MAX_DISPERSION = 0.35

// Ask-corroboration (A2, 2026-06-05). When an edition's sales central price
// agrees with an independent live ask, that second signal lifts a LOW edition
// to MEDIUM — even at a sales count below the MEDIUM volume floor. The live ask
// (edition_offers.low_ask) is a FLOOR: it is used ONLY to corroborate (raise),
// NEVER to clamp/lower a sales-based FMV (a lowball listing must not crush a
// correct price). Held at LOW->MEDIUM only — MEDIUM->HIGH would override the
// strict serial-dispersion HIGH gate, and an honest MEDIUM beats a flattering
// HIGH. Modeled lift: ~1,291 TS LOW editions rescue, ~915 correctly stay LOW.
export const MIN_SALES_ASK_CORROBORATION = 3
export const ASK_CORROBORATION_BAND = 0.25 // sales median within +/-25% of the ask

// 🚨 THE ASK HAD NO AGE BOUND AT ALL until 2026-08-29, so "an independent LIVE ask"
// could be an ask nobody had confirmed in three months. `edition_offers` holds rows
// up to 87 days old, and 83 Top Shot rows were over 30 days — each of them able to
// lift an edition to MEDIUM, which in turn is what gates the public Below-FMV board.
//
// ⚠⚠ THE THRESHOLD IS 7 DAYS AND NOT 12 HOURS, AND THAT IS A MEASUREMENT, NOT A
// PREFERENCE. The obvious move is to reuse `ASK_STALE_HOURS` (12 h) from
// lib/market/ask-freshness.ts, which is what the boards mark a row unconfirmed at.
// Measured before shipping: of 12,259 Top Shot asks, **12,121 (98.9%) were older than
// 12 h** during the offers-sweep outage, **168 (1.4%) older than 3 days, 155 (1.3%)
// older than 7, 83 (0.7%) older than 30**. A 12 h gate would therefore have demoted
// essentially the whole catalogue out of MEDIUM — and off the deals board — because
// of a transient upstream failure. A 7-day gate touches ~1.3% and removes only asks
// that have genuinely stopped being evidence.
//
// ⭐ THE TWO THRESHOLDS ANSWER DIFFERENT QUESTIONS AND MUST NOT BE UNIFIED.
// `ASK_STALE_HOURS` (display): "we have not re-checked this, so look before you act."
// `MAX_ASK_AGE_HOURS_CORROBORATION` (pricing): "this ask is so old it is no longer
// evidence about the price." A 30-hour-old ask that agrees with the recent sales
// median is still corroboration; it just is not something to trade on unseen.
export const MAX_ASK_AGE_HOURS_CORROBORATION = 24 * 7

function medianPrice(prices: number[]): number {
  if (prices.length === 0) return 0
  const s = [...prices].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

// Volume-only base tier. HIGH is deliberately never assigned here — it requires
// the dispersion gate in escalateConfidence().
export function computeConfidence(salesCount: number): FmvConfidence {
  if (salesCount >= MIN_SALES_30D_MEDIUM) return "MEDIUM"
  return "LOW"
}

// Volume-tier recency gate (Trevor, 2026-08-07: "HIGH stays >=7 sales/30d").
// fmv-recalc widens a thin edition's sales window to 90d so it can price + earn
// MEDIUM off the wider set — but HIGH must stay reserved for editions liquid in
// the RECENT 30d window. Pass the TRUE 30-day count (not the widened count):
// a HIGH that wasn't earned on >=MIN_SALES_30D_HIGH recent sales is demoted to
// MEDIUM. Anything not HIGH passes through untouched (MEDIUM/LOW/ASK_ONLY/…).
export function gateHighToRecentVolume<T extends string>(confidence: T, salesCount30d: number): T {
  return confidence === "HIGH" && salesCount30d < MIN_SALES_30D_HIGH ? ("MEDIUM" as T) : confidence
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

// Refine the base tier using the volume floor + the residual-dispersion gate.
//   count < MIN_SALES_30D_MEDIUM       → LOW
//   count in [MEDIUM, HIGH)            → MEDIUM (volume floor; no fit yet)
//   count >= MIN_SALES_30D_HIGH        → graded by dispersion:
//     dispersion < HIGH_MAX_DISPERSION   → HIGH
//     dispersion < MEDIUM_MAX_DISPERSION → MEDIUM (dispersion-confirmed)
//     dispersion >= MEDIUM_MAX_DISPERSION → LOW (noisy despite volume)
//
// Pass `serials` (parallel to `prices`, one entry per sale) to use the
// serial-residual gate; omit it to use the raw coefficient of variation.
export function escalateConfidence(
  base: FmvConfidence,
  salesCount30d: number,
  prices: number[],
  serials?: (number | null | undefined)[],
  liveAsk?: number | null,
  /**
   * Age of `liveAsk` in hours. THREE STATES, and they are not interchangeable:
   *   - a number  → dated; corroborates only under MAX_ASK_AGE_HOURS_CORROBORATION
   *   - `null`    → the caller HAD an ask and could not date it → does NOT corroborate
   *   - omitted   → the caller is not age-aware at all (legacy path)
   * ⚠ The null case is deliberately stricter than the omitted case. An undatable ask
   * is exactly the shape this gate exists to catch, and treating "I could not tell"
   * as "recent enough" is the failed-read-as-answer defect one layer down.
   * ⚠ The omitted case preserves the pre-2026-08-29 behaviour so a caller that passes
   * no ask is unaffected — `__tests__` pins that fmv-recalc, the only caller that DOES
   * pass an ask, supplies the age, so the legacy path cannot quietly become production.
   */
  liveAskAgeHours?: number | null,
): FmvConfidence {
  let confidence = base

  if (confidence === "LOW" && salesCount30d >= MIN_SALES_30D_MEDIUM) {
    confidence = "MEDIUM"
  }

  if (
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
    } else if (dispersion < MEDIUM_MAX_DISPERSION) {
      confidence = "MEDIUM"
    } else {
      // Enough volume for a reliable fit, but the residual is too noisy to
      // call MEDIUM in good faith. Demote rather than overstate confidence.
      confidence = "LOW"
    }
  }

  // Ask-corroboration: a live ask that agrees with the sales median rescues a
  // LOW edition to MEDIUM (covers both the thin-but-confirmed 3-4 sale editions
  // and the count>=7 editions the dispersion gate demoted). Corroborate only —
  // the ask is a floor and is never used to lower confidence.
  const askIsDatedAndCurrent =
    liveAskAgeHours === undefined ||
    (liveAskAgeHours !== null && liveAskAgeHours < MAX_ASK_AGE_HOURS_CORROBORATION)
  if (
    confidence === "LOW" &&
    liveAsk != null &&
    liveAsk > 0 &&
    askIsDatedAndCurrent &&
    salesCount30d >= MIN_SALES_ASK_CORROBORATION &&
    prices.length > 0
  ) {
    const med = medianPrice(prices)
    if (med > 0) {
      const ratio = med / liveAsk
      if (ratio >= 1 - ASK_CORROBORATION_BAND && ratio <= 1 + ASK_CORROBORATION_BAND) {
        confidence = "MEDIUM"
      }
    }
  }

  return confidence
}
