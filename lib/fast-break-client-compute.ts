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
