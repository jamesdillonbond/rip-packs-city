// fast-break-client-compute — pure lineup/eligibility/tier logic lifted out of
// components/fast-break/FastBreakClient.tsx so it lands under the vitest
// coverage `include` (lib/**), which does NOT measure components/**. No
// React/JSX, no browser globals — behavior is identical to the inline code it
// replaced.

export type Tier = "COMMON" | "FANDOM" | "RARE" | "LEGENDARY" | "ULTIMATE"

export interface TierToken {
  color: string
  bg: string
  border: string
  label: string
}

export const TIER_TOKEN: Record<Tier, TierToken> = {
  COMMON:    { color: "var(--tier-common)",    bg: "var(--tier-common-bg)",    border: "var(--tier-common-border)",    label: "Common" },
  FANDOM:    { color: "var(--tier-fandom)",    bg: "var(--tier-fandom-bg)",    border: "var(--tier-fandom-border)",    label: "Fandom" },
  RARE:      { color: "var(--tier-rare)",      bg: "var(--tier-rare-bg)",      border: "var(--tier-rare-border)",      label: "Rare" },
  LEGENDARY: { color: "var(--tier-legendary)", bg: "var(--tier-legendary-bg)", border: "var(--tier-legendary-border)", label: "Legendary" },
  ULTIMATE:  { color: "var(--tier-ultimate)",  bg: "var(--tier-ultimate-bg)",  border: "var(--tier-ultimate-border)",  label: "Ultimate" },
}

// Rarest → most common; drives the Run Progress grouping order.
export const TIER_ORDER: Tier[] = ["ULTIMATE", "LEGENDARY", "RARE", "FANDOM", "COMMON"]

// Token lookup with a COMMON fallback for any unexpected/absent tier.
export function tierToken(tier: Tier): TierToken {
  return TIER_TOKEN[tier] ?? TIER_TOKEN.COMMON
}

export function thumbnailFor(momentId: string | null | undefined): string | null {
  if (!momentId) return null
  return `https://assets.nbatopshot.com/media/${momentId}/image?width=180`
}

// Two-letter avatar fallback: first+last initial, or first two chars of a
// single-word name, or "??" when empty.
export function initialsFor(fullName: string | null | undefined): string {
  if (!fullName) return "??"
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "??"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// ── Uses / eligibility math ───────────────────────────────────────────

export interface UseRowLike {
  nbaPlayerId: string
  highestTierOwned: Tier
  totalAllowed: number
  timesUsed: number
  remainingUses: number
}

// Apply the optimistic per-player use bumps to the authoritative rows,
// clamping timesUsed to [0, totalAllowed] and recomputing remainingUses.
// Returns the base array unchanged when there are no pending bumps.
export function applyOptimisticUses<T extends UseRowLike>(
  base: T[],
  optimisticUses: Record<string, number>,
): T[] {
  if (Object.keys(optimisticUses).length === 0) return base
  return base.map(r => {
    const bump = optimisticUses[r.nbaPlayerId] ?? 0
    const next = Math.max(0, Math.min(r.totalAllowed, r.timesUsed + bump))
    return { ...r, timesUsed: next, remainingUses: r.totalAllowed - next }
  })
}

export interface TierGroup<T> {
  tier: Tier
  rows: T[]
}

// Group rows by highest tier owned, in TIER_ORDER, dropping empty tiers.
export function groupUsesByTier<T extends { highestTierOwned: Tier }>(rows: T[]): TierGroup<T>[] {
  return TIER_ORDER.map(tier => {
    const tierRows = rows.filter(r => r.highestTierOwned === tier)
    if (tierRows.length === 0) return null
    return { tier, rows: tierRows }
  }).filter(Boolean) as TierGroup<T>[]
}

// Merge a save response's added/removed player lists into the optimistic-use
// map: +1 per added, -1 per removed (floored at 0). Returns a new record.
export function applyUseBumps(
  current: Record<string, number>,
  added: string[],
  removed: string[],
): Record<string, number> {
  const bumps: Record<string, number> = { ...current }
  for (const id of added) bumps[id] = (bumps[id] ?? 0) + 1
  for (const id of removed) bumps[id] = Math.max(0, (bumps[id] ?? 0) - 1)
  return bumps
}

// ── run-badge status ───────────────────────────────────────────────────────
//
// 🚨 2026-09-19: the Fast Break hero badge derived "this run is LIVE" from the
// `is_active` BOOLEAN ALONE — a pulsing red dot, red border, and the label
// "Ends <date>" in the future tense. Measured against production the same day:
//
//   GET /api/nba/fast-break/optimize
//   → run_name "Playoffs Run 1", run_is_active TRUE, run_end_date "2026-05-19"
//
// i.e. a run that ended FOUR MONTHS earlier still rendered as live and
// "Ends May 19", to a visitor in September. ⛔ The flag is wrong in the data
// (`fast_break_runs` carries is_active on the OLDER of two runs, both long
// finished) and fixing that is a product/data decision — but the surface should
// not be able to claim "live" for a date it is already holding and can compare.
//
// So the badge keys on BOTH: a run is live only while it is flagged active AND
// its end date has not passed. A finished run reads "Ended", past tense, with
// the live treatment off — which is true whatever the flag says.
//
// ⚠ `run_end_date` is a plain YYYY-MM-DD calendar date and is compared as a
// STRING against a UTC "today" of the same shape. No Date parsing, so no
// timezone can shift the comparison across a day boundary (the payload's own
// dates are rendered with timeZone "UTC" for the same reason).
export type RunBadge = { live: boolean; label: "Ends" | "Ended" | "From" }

export function runBadgeStatus(
  meta: { run_is_active?: boolean; run_end_date?: string } | null | undefined,
  todayUtc: string,
): RunBadge {
  const endDate = meta?.run_end_date
  const flaggedActive = meta?.run_is_active === true
  // No end date: the flag is all there is, so trust it rather than invent one.
  if (!endDate) return { live: flaggedActive, label: flaggedActive ? "Ends" : "From" }
  const finished = endDate < todayUtc
  if (finished) return { live: false, label: "Ended" }
  return { live: flaggedActive, label: flaggedActive ? "Ends" : "From" }
}

/** Today as YYYY-MM-DD in UTC — the shape `run_end_date` uses. */
export function todayUtcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
