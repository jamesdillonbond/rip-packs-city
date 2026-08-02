// Pure filter + sort for the Sets page's set list
// (app/(collections)/[collection]/sets/page.tsx — a ~900-line client monolith
// neither coverage gate measures). Byte-identical to the page's `displaySets`
// useMemo; the page imports this.

export type SetSortKey = "completion" | "cost" | "name"
export type SetFilterKey = "all" | "complete" | "in_progress" | "not_started"

// Tier → accent stripe color for the set-progress cards. Covers both the NBA
// Top Shot vocabulary (COMMON…ULTIMATE) and the UFC Strike additions
// (CHALLENGER/CONTENDER/CHAMPION); anything unknown falls back to COMMON so a
// new/mis-cased tier renders a neutral stripe rather than nothing.
export const TIER_STRIPE: Record<string, string> = {
  COMMON: "#9ca3af",
  UNCOMMON: "var(--tier-uncommon)",
  FANDOM: "#60a5fa",
  RARE: "#a855f7",
  LEGENDARY: "#fbbf24",
  ULTIMATE: "#ec4899",
  // UFC Strike tier vocabulary
  CHALLENGER: "var(--tier-challenger)",
  CONTENDER: "var(--tier-contender)",
  CHAMPION: "var(--tier-champion)",
}

export function tierStripeColor(tier: string | null | undefined): string {
  if (!tier) return TIER_STRIPE.COMMON
  return TIER_STRIPE[tier.toUpperCase()] ?? TIER_STRIPE.COMMON
}

/** Minimal set-progress shape the filter/sort read. */
export interface DisplaySet {
  completionPct: number
  totalMissingCost?: number | null
  setName: string
}

/** Apply the completion filter, then sort by completion (desc), cost (asc,
 * missing cost sorts last), or set name (locale). Returns a new array. */
export function filterAndSortSets<S extends DisplaySet>(
  sets: S[],
  filter: SetFilterKey,
  sortBy: SetSortKey,
): S[] {
  let out = [...sets]

  if (filter === "complete") out = out.filter((s) => s.completionPct === 100)
  else if (filter === "in_progress") out = out.filter((s) => s.completionPct > 0 && s.completionPct < 100)
  else if (filter === "not_started") out = out.filter((s) => s.completionPct === 0)

  out.sort((a, b) => {
    if (sortBy === "completion") return b.completionPct - a.completionPct
    if (sortBy === "cost") {
      const ca = a.totalMissingCost ?? Infinity
      const cb = b.totalMissingCost ?? Infinity
      return ca - cb
    }
    return a.setName.localeCompare(b.setName)
  })

  return out
}

/* Header summary counts for the sets page — extracted verbatim from
 * app/(collections)/[collection]/sets/page.tsx. totalSets/completeSets come
 * straight from the API; inProgress/notStarted fall back to counting the sets
 * array when the API omits them; completePct is the clamped completion ratio.
 * Pure. */
export function computeSetSummary(
  data:
    | {
        totalSets: number
        completeSets: number
        inProgressSets?: number
        notStartedSets?: number
        sets: Array<{ completionPct: number }>
      }
    | null
    | undefined,
): { totalSets: number; completeSets: number; inProgressSets: number; notStartedSets: number; completePct: number } {
  const totalSets = data?.totalSets ?? 0
  const completeSets = data?.completeSets ?? 0
  const inProgressSets =
    data?.inProgressSets ?? (data ? data.sets.filter((s) => s.completionPct > 0 && s.completionPct < 100).length : 0)
  const notStartedSets =
    data?.notStartedSets ?? (data ? data.sets.filter((s) => s.completionPct === 0).length : 0)
  const completePct = totalSets > 0 ? Math.min(100, Math.max(0, Math.round((completeSets / totalSets) * 100))) : 0
  return { totalSets, completeSets, inProgressSets, notStartedSets, completePct }
}
