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
//     first  — serial #1                     (n=81,     ~15.8x)
//     low5   — serial within the top 5%      (n=649,     ~2.2x)
//     low20  — serial within the top 20%     (n=2,297,   ~1.2x)
//     normal — everything else               (n=14,859,   1.0x)
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

export type PinnacleSerialBand = "first" | "low5" | "low20" | "normal"

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
    if (band !== "first" && band !== "low5" && band !== "low20" && band !== "normal") continue
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
 * has no band, and a mint of null or <= 1 cannot express a position so it reads
 * as `normal`. Returns null when no band applies.
 */
export function pinnacleSerialBand(serial: number | null | undefined, mint: number | null | undefined): PinnacleSerialBand | null {
  if (serial == null || !Number.isFinite(serial) || serial <= 0) return null
  if (serial === 1) return "first"
  if (mint == null || !Number.isFinite(mint) || mint <= 1) return "normal"
  const position = serial / mint
  if (position <= 0.05) return "low5"
  if (position <= 0.2) return "low20"
  return "normal"
}

export interface SerialFmvOptions {
  /**
   * Apply the mint>=25 display guard. Consumer surfaces pass true; anything
   * reproducing the raw fitted model passes false.
   */
  applyMinMintGuard?: boolean
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
 * The "what would a better serial of this pin be worth" ladder shown on a
 * render page. Returns null when the render is unpriced, below the mint guard,
 * or the model has no reliable premium band to show — the page renders nothing
 * rather than a one-row ladder that says only "typical".
 */
export function pinnacleSerialLadder(
  mint: number | null | undefined,
  baseFmv: number | null | undefined,
  mults: PinnacleSerialMultipliers,
): SerialLadderRow[] | null {
  const base = baseFmv == null ? NaN : Number(baseFmv)
  const m = mint == null ? NaN : Number(mint)
  if (!Number.isFinite(base) || base <= 0) return null
  if (!Number.isFinite(m) || m < PINNACLE_SERIAL_MIN_MINT) return null
  if (!mults.first && !mults.low5 && !mults.low20) return null

  const top5 = Math.max(2, Math.round(m * 0.05))
  const rows: SerialLadderRow[] = []
  if (mults.first) rows.push({ label: "#1", note: "serial #1", estimate: base * mults.first, mult: mults.first })
  if (mults.low5) rows.push({ label: "low serial", note: `#2–#${top5} (top 5%)`, estimate: base * mults.low5, mult: mults.low5 })
  if (mults.low20) rows.push({ label: "mid serial", note: "top 20%", estimate: base * mults.low20, mult: mults.low20 })
  rows.push({ label: "typical", note: "most serials", estimate: base, mult: 1 })
  return rows
}
