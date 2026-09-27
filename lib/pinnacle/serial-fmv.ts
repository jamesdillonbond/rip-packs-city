// lib/pinnacle/serial-fmv.ts
//
// The single implementation of the Disney Pinnacle serial-premium overlay.
//
// ── What the model is ──────────────────────────────────────────────────────
// `pinnacle_catalog.fmv_usd` is a RENDER-level FMV: what a typical serial of
// that pin is worth. It says nothing about serial position. The fitted overlay
// in `pinnacle_serial_fmv_multipliers` (refreshed weekly, Sun 12:00 UTC, by
// `compute_pinnacle_serial_fmv_multipliers`) supplies the per-band premium:
//
//     first   — serial #1                          (n=50, ~14.5x, 09-27 fit)
//     perfect — serial #N of N (the last serial)   (n=36,  ~3.5x)
//     normal  — every other serial                 (1.0x)
//
// ⚠ 2026-09-27 (Trevor): "our typical FMV pattern … only should apply serial
// premiums for #1 and Perfect Serials" — the shared serial_fmv_estimate rule.
// The old top-5% (~2.5x) and top-20% (~1.2x) bands are GONE; a low serial earns
// no premium. Like the shared estimator, a premium is only claimed over a HIGH
// or MEDIUM confidence base FMV (`baseConfidence`).
//
// Bands are normalised so `normal` = 1.0, which is why an estimate is simply
// `render FMV x band multiplier`. Only bands flagged `is_reliable` are applied.
//
// ── Why this file exists ───────────────────────────────────────────────────
// The band boundaries were implemented TWICE: once in the SQL function
// `pinnacle_serial_fmv_estimate(serial, mint_count, base_fmv)` and once inline
// in the Pinnacle moment page's TypeScript. Two copies of a pricing rule drift,
// and a drifting pricing rule is the expensive kind. Every consumer now goes
// through `pinnacleSerialBand` / `pinnacleSerialFmv` here, and the band
// boundaries below are deliberately identical to the SQL function's (see the
// cross-agreement test in __tests__/pinnacle-serial-fmv.test.ts).
//
// ── The mint>=25 display guard ─────────────────────────────────────────────
// The population curve — especially the ~15.8x `first` band — was fit where a
// #1 stands out from hundreds of serials. On a tiny-mint chase pin the WHOLE
// edition is scarce and serial position is not the price driver, so a 15.8x #1
// estimate would be absurd. Consumer surfaces therefore apply the overlay only
// at mint >= 25. That guard is a DISPLAY rule, not part of the fitted model, so
// it lives here rather than in the SQL function — and it is why
// `pinnacleSerialFmv` takes it as an explicit option instead of assuming it.

export type PinnacleSerialBand = "first" | "perfect" | "normal"

/** Multipliers keyed by band. Only `is_reliable` rows should be loaded in. */
export type PinnacleSerialMultipliers = Partial<Record<PinnacleSerialBand, number>>

export interface PinnacleMultiplierRow {
  band: string
  multiplier: number | string
  is_reliable: boolean
}

/** Below this mint the serial-premium curve is not meaningful — see header. */
export const PINNACLE_SERIAL_MIN_MINT = 25

/**
 * Keep only reliable bands, coerced to numbers. Rows that are unreliable, have
 * an unknown band, or carry a non-finite multiplier are dropped rather than
 * defaulted — a missing band means "no premium claimed", which is the honest
 * reading.
 */
export function toMultiplierMap(rows: PinnacleMultiplierRow[] | null | undefined): PinnacleSerialMultipliers {
  const out: PinnacleSerialMultipliers = {}
  for (const r of rows ?? []) {
    if (!r?.is_reliable) continue
    const band = r.band as PinnacleSerialBand
    // A stale low5/low20 row (the pre-09-27 fit) is an unknown band now: dropped.
    if (band !== "first" && band !== "perfect" && band !== "normal") continue
    const m = Number(r.multiplier)
    if (!Number.isFinite(m) || m <= 0) continue
    out[band] = m
  }
  return out
}

/**
 * Which premium band does this serial fall in?
 *
 * Mirrors `pinnacle_serial_fmv_estimate` exactly: a null/non-positive serial
 * has no band; #1 is `first` (even on a mint of 1); the last serial of a mint
 * > 1 is `perfect`; every other serial is `normal`. Returns null when no band applies.
 */
export function pinnacleSerialBand(serial: number | null | undefined, mint: number | null | undefined): PinnacleSerialBand | null {
  if (serial == null || !Number.isFinite(serial) || serial <= 0) return null
  if (serial === 1) return "first"
  if (mint != null && Number.isFinite(mint) && mint > 1 && serial === mint) return "perfect"
  return "normal"
}

export interface SerialFmvOptions {
  /**
   * Apply the mint>=25 display guard. Consumer surfaces pass true; anything
   * reproducing the raw fitted model passes false.
   */
  applyMinMintGuard?: boolean
  /**
   * The base FMV's confidence. When PASSED, a premium band (first / perfect) is
   * only estimated over HIGH or MEDIUM — the shared serial_fmv_estimate gate:
   * multiplying an unreliable base by x14 publishes noise as a price. Omit it
   * to reproduce the raw fitted model.
   */
  baseConfidence?: string | null
}

export interface PinnacleSerialFmv {
  band: PinnacleSerialBand
  multiplier: number
  /** render FMV x multiplier, rounded to cents. */
  estimate: number
}

/**
 * The serial-adjusted estimate for one holding. Returns null — never a
 * fabricated number — when the base FMV is missing, the serial has no band, the
 * band has no reliable multiplier, or the mint is below the display guard.
 *
 * A `normal`-band holding returns its base FMV at multiplier 1.0 rather than
 * null, so callers can distinguish "no premium" from "not estimable".
 */
export function pinnacleSerialFmv(
  serial: number | null | undefined,
  mint: number | null | undefined,
  baseFmv: number | null | undefined,
  mults: PinnacleSerialMultipliers,
  opts: SerialFmvOptions = {},
): PinnacleSerialFmv | null {
  const base = baseFmv == null ? NaN : Number(baseFmv)
  if (!Number.isFinite(base) || base <= 0) return null

  const band = pinnacleSerialBand(serial, mint)
  if (band == null) return null

  if (opts.applyMinMintGuard) {
    if (mint == null || !Number.isFinite(mint) || mint < PINNACLE_SERIAL_MIN_MINT) return null
  }

  if (band !== "normal" && opts.baseConfidence !== undefined) {
    const c = (opts.baseConfidence ?? "").toUpperCase()
    if (c !== "HIGH" && c !== "MEDIUM") return null
  }

  const multiplier = mults[band]
  if (multiplier == null) return null

  return { band, multiplier, estimate: Math.round(base * multiplier * 100) / 100 }
}

export interface SerialLadderRow {
  label: string
  note: string
  estimate: number
  mult: number
}

/**
 * The "what would a #1 / perfect serial of this pin be worth" ladder shown on a
 * render page. Returns null when the render is unpriced, below the mint guard,
 * its FMV is not HIGH/MEDIUM confidence (when given), or the model has no
 * reliable premium band — the page renders nothing rather than a one-row
 * ladder that says only "typical".
 */
export function pinnacleSerialLadder(
  mint: number | null | undefined,
  baseFmv: number | null | undefined,
  mults: PinnacleSerialMultipliers,
  baseConfidence?: string | null,
): SerialLadderRow[] | null {
  const base = baseFmv == null ? NaN : Number(baseFmv)
  const m = mint == null ? NaN : Number(mint)
  if (!Number.isFinite(base) || base <= 0) return null
  if (!Number.isFinite(m) || m < PINNACLE_SERIAL_MIN_MINT) return null
  if (baseConfidence !== undefined) {
    const c = (baseConfidence ?? "").toUpperCase()
    if (c !== "HIGH" && c !== "MEDIUM") return null
  }
  if (!mults.first && !mults.perfect) return null

  const rows: SerialLadderRow[] = []
  if (mults.first) rows.push({ label: "#1", note: "serial #1", estimate: base * mults.first, mult: mults.first })
  if (mults.perfect) rows.push({ label: "perfect", note: `#${m} of ${m} (the last serial)`, estimate: base * mults.perfect, mult: mults.perfect })
  rows.push({ label: "typical", note: "every other serial", estimate: base, mult: 1 })
  return rows
}

/**
 * The shared serial-estimate shape (`SerialFmvData`, rendered by
 * `SerialFmvBadge` on every collection's table and sniper) for one Pinnacle
 * holding or listing — or null when there is no #1 / perfect premium to claim.
 * A `normal` serial returns null: no premium is not a serial ESTIMATE.
 */
export function pinnacleSerialFmvData(
  est: PinnacleSerialFmv | null,
): { estimate_usd: number; multiplier: number; serial_bucket: "first" | "perfect"; label: string; basis: string } | null {
  if (!est || est.band === "normal") return null
  return {
    estimate_usd: est.estimate,
    multiplier: Math.round(est.multiplier * 100) / 100,
    serial_bucket: est.band,
    label: est.band === "first" ? "estimated #1 premium" : "estimated perfect-mint premium",
    basis: "pinnacle_serial_model",
  }
}
