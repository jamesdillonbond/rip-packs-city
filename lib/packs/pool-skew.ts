// lib/packs/pool-skew.ts
//
// Is a drawn-down Top Shot pool MEASURABLY free of survivor bias? (2026-11-27)
//
// The board and pack pages warn "survivor-biased" from depletion alone (≥ 60 / 70 / 90 % of the
// pool opened). Measured 11-27: standard packs keep their launch mix to the end (Base Set, Playoffs,
// Run It Back 2005-06: remaining-weighted mean FMV ÷ launch-weighted mean FMV ≈ 1.0 at 98 % drawn),
// chase packs do not (Grail Seekers February 5.6×, Top Shot Debut Chance Hit 4.1×). public.topshot_pool_skew
// (hourly, migration 20261127184627) carries that ratio per pool.
//
// This only ever REMOVES a depletion warning, and only when every condition holds. Anything missing,
// unreadable or unmeasurable returns false and the page keeps today's warning.
//   - listed_share ≥ 0.95: the Atlas pool table drops an edition once it sells out, so a pool whose
//     listed launch copies fall short of total_minted × slots has lost editions we cannot see
//     (dist 5223: 0.10). Its mix is unmeasurable.
//   - skew < 1.5 over what is listed.
//   - fmv_coverage ≥ 0.95 of the remaining copies.
//   - the pool read is ≤ 60 days old. (The board's depletion and EV come from this same read —
//     1,524 of 1,633 Top Shot pools agree within 1.5 points — so this is a sanity bound, not a gate
//     that makes the ratio fresher than the EV it qualifies.)

export const POOL_SKEW_MAX = 1.5
export const POOL_LISTED_SHARE_MIN = 0.95
export const POOL_SKEW_FMV_COVERAGE_MIN = 0.95
export const POOL_SKEW_MAX_AGE_MS = 60 * 24 * 3600 * 1000

export type PoolSkewRow = {
  dist_id: string
  listed_share: number | string | null
  skew: number | string | null
  fmv_coverage: number | string | null
  pool_fetched_at: string | null
}

function n(v: number | string | null | undefined): number | null {
  if (v == null) return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

export function poolMixMeasuredFlat(row: PoolSkewRow | null | undefined, nowMs: number = Date.now()): boolean {
  if (!row) return false
  const share = n(row.listed_share)
  const skew = n(row.skew)
  const cov = n(row.fmv_coverage)
  const fetched = row.pool_fetched_at ? Date.parse(row.pool_fetched_at) : NaN
  if (share == null || share < POOL_LISTED_SHARE_MIN) return false
  if (skew == null || skew >= POOL_SKEW_MAX) return false
  if (cov == null || cov < POOL_SKEW_FMV_COVERAGE_MIN) return false
  if (!Number.isFinite(fetched) || nowMs - fetched > POOL_SKEW_MAX_AGE_MS) return false
  return true
}

export const POOL_SKEW_COLUMNS = "dist_id, listed_share, skew, fmv_coverage, pool_fetched_at"
