// lib/entity/recent-low.ts
//
// fmv_snapshots.floor_price_usd means "lowest recent sale or ask" (#143). Some writers carry an
// old ask forward: 2026-10-25, a Top Shot /1 read Recent Low $57,000 over a $1,700 FMV (its last
// sale), which also inflated its set's Recent-Low Total by $55k. A "recent low" above 3x FMV is an
// ask the market does not clear at, so it is not shown as one — the same 3x bound the live-ask
// readers use (lib/asks/edition-live-ask.ts). Mirrors public.recent_low_usd(), which the header
// totals call (supabase/migrations/20261025221903_…).

export const RECENT_LOW_MAX_FMV_MULTIPLE = 3

/** The floor when it is > 0 and at most 3x FMV (or FMV is unknown), else null. */
export function recentLowUsd(floor: number | null | undefined, fmv: number | null | undefined): number | null {
  if (typeof floor !== "number" || !Number.isFinite(floor) || floor <= 0) return null
  if (typeof fmv !== "number" || !Number.isFinite(fmv) || fmv <= 0) return floor
  return floor <= RECENT_LOW_MAX_FMV_MULTIPLE * fmv ? floor : null
}
