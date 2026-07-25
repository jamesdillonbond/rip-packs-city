// lib/rtr-lock-roi-weights.ts
//
// Calibration constants + helpers for the RTR "Lock ROI" playoff-points
// estimate (app/api/rtr/lock-roi/route.ts). Extracted into a standalone,
// unit-tested module so the interim heuristics live in one place and can be
// tuned + pinned once real Top Shot Run 2 scoring data is collected. This
// resolves the standing "calibrate the absolute curve" TODO that the route
// carried inline: the numbers still need fitting against observed scoring, but
// they are now a documented, testable surface rather than magic literals buried
// in a request handler.
//
// MODEL (v2): estimatedPlayoffPoints ≈ (fmv / 10) · tierWeight · serialScarcity.
// FMV sets the base magnitude (a moment's market price already encodes
// desirability); tier and serial scarcity scale it. The weights are
// ordinal/relative heuristics (rarer tier ⇒ more points, lower serial ⇒ more
// points), NOT calibrated absolute point values — keep them relative and
// conservative until the real Run 2 curve is fit against observed data.

// Base FMV-to-points divisor. The estimate derives from fmv / this before tier
// and scarcity scaling (v1 was a flat floor(fmv / 10)).
export const FMV_POINTS_DIVISOR = 10

// Neutral weight applied to an unknown / unmapped tier or serial.
export const NEUTRAL_WEIGHT = 1.0

// Ordinal tier weights (COMMON baseline 1.0 … ULTIMATE 6.0). Rarer tier ⇒ more
// points. Keys are the UPPERCASE tier_type enum values Top Shot uses.
export const TIER_POINT_WEIGHT: Record<string, number> = {
  COMMON: 1.0,
  FANDOM: 1.1,
  RARE: 1.6,
  LEGENDARY: 3.0,
  ULTIMATE: 6.0,
}

// Serial-scarcity decay. Lower serials are scarcer and carry a real serial
// premium; give them a small, bounded lift that decays to ~1.0 by the time
// serials run into the hundreds. The factor is bounded to
// [1.0, 1 + SERIAL_SCARCITY_MAX_LIFT] so scarcity nudges ties but never
// dominates tier or FMV.
export const SERIAL_SCARCITY_MAX_LIFT = 0.25 // factor ∈ [1.0, 1.25]
export const SERIAL_SCARCITY_DECAY = 250 // e-folding serial; ~1.0 by the low hundreds

// Ordinal points weight for a tier. Case/whitespace-insensitive; unknown or
// null tiers fall back to the neutral weight so an unmapped tier never zeroes
// or spikes a moment.
export function tierPointWeight(tier: string | null | undefined): number {
  if (!tier) return NEUTRAL_WEIGHT
  return TIER_POINT_WEIGHT[tier.trim().toUpperCase()] ?? NEUTRAL_WEIGHT
}

// Bounded serial-scarcity multiplier. Unknown / non-positive / non-finite
// serials get the neutral 1.0.
export function serialScarcityFactor(serial: number | null | undefined): number {
  if (serial == null || !Number.isFinite(serial) || serial <= 0) return NEUTRAL_WEIGHT
  return 1 + SERIAL_SCARCITY_MAX_LIFT * Math.exp(-serial / SERIAL_SCARCITY_DECAY)
}

// Unrounded playoff-points estimate. Callers round for a clean integer display
// but should keep this raw value for pointsPerDollar so a cheap moment retains
// a meaningful (non-zero) ratio and isn't unfairly dumped to the bottom.
// Returns 0 for a non-positive / non-finite FMV (those rows are dropped
// upstream anyway).
export function estimatePlayoffPointsRaw(
  fmvUsd: number,
  tier: string | null | undefined,
  serial: number | null | undefined,
): number {
  if (!Number.isFinite(fmvUsd) || fmvUsd <= 0) return 0
  return (fmvUsd / FMV_POINTS_DIVISOR) * tierPointWeight(tier) * serialScarcityFactor(serial)
}
