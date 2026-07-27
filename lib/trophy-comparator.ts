// Auto-Arrange sort comparators for the dashboard trophy case
// (app/dashboard/page.tsx). Extracted so the five sort orderings + tie-breakers
// (which decide how a collector's showcased moments are arranged) are unit-tested.
//
// NOTE the tier ranking here is a CROSS-COLLECTION vocabulary (all 5 collections'
// tier_type enum values). It is deliberately NOT unified with
// lib/trophy-picker-format.ts's `tierRank`, and that is a considered decision, not
// debt — the two encode GENUINELY DIFFERENT orderings for different surfaces:
//   • this one (dashboard trophy case): cross-collection, descending score,
//     ranks UNCOMMON(5) ABOVE FANDOM(2), and includes CHAMPION/CHALLENGER/
//     CONTENDER (UFC).
//   • trophy-picker-format (profile picker modal): Top-Shot-only NormalizedTier,
//     ascending index, ranks FANDOM(3) ABOVE UNCOMMON(4), and has no UFC tiers.
// Forcing one canonical rank would FLIP the FANDOM/UNCOMMON order on one surface
// (a behavior change with no clear "correct" answer — the relationship is
// collection-dependent), so they intentionally stay separate.

/**
 * Cross-collection rarity ranking, highest first. Covers every tier in the
 * tier_type enum; unknown/null → 0 (lowest). (Top Shot: COMMON<FANDOM<RARE<
 * LEGENDARY<ULTIMATE; UFC: CONTENDER<CHALLENGER<FANDOM.)
 */
export const TROPHY_TIER_RANK: Record<string, number> = {
  ULTIMATE: 9,
  LEGENDARY: 8,
  CHAMPION: 7,
  RARE: 6,
  UNCOMMON: 5,
  CHALLENGER: 4,
  CONTENDER: 3,
  FANDOM: 2,
  COMMON: 1,
}

export const tierRank = (t: string | null | undefined): number =>
  TROPHY_TIER_RANK[(t ?? "").toUpperCase()] ?? 0

export type TrophySortKey = "rarity" | "fmv" | "serial" | "player" | "set"

export const TROPHY_SORTS: { key: TrophySortKey; label: string }[] = [
  { key: "rarity", label: "Rarity (highest)" },
  { key: "fmv", label: "Value (highest)" },
  { key: "serial", label: "Serial (lowest)" },
  { key: "player", label: "Player (A–Z)" },
  { key: "set", label: "Set / Series" },
]

/** Minimal moment shape the comparators read (the dashboard's TrophySlabData satisfies it). */
export interface TrophySortFields {
  tier?: string | null
  fmv?: number | null
  serial_number?: number | null
  player_name?: string | null
  set_name?: string | null
  series?: number | null
}

/**
 * Comparator for the chosen sort key. Each key has a deterministic tie-breaker so
 * the order is stable: rarity→fmv, fmv→rarity, serial(asc)→fmv, player→serial,
 * set→series→serial. Missing numbers sort to the "worst" end (Infinity for asc,
 * -Infinity for desc) so they never jump to the top; missing strings sort last.
 */
export function trophyComparator<T extends TrophySortFields>(key: TrophySortKey): (a: T, b: T) => number {
  const num = (v: number | null | undefined, fallback: number) =>
    v === null || v === undefined || Number.isNaN(v) ? fallback : v
  const str = (v: string | null | undefined) => (v ?? "￿").toLowerCase()
  switch (key) {
    case "rarity":
      return (a, b) => tierRank(b.tier) - tierRank(a.tier) || num(b.fmv, -Infinity) - num(a.fmv, -Infinity)
    case "fmv":
      return (a, b) => num(b.fmv, -Infinity) - num(a.fmv, -Infinity) || tierRank(b.tier) - tierRank(a.tier)
    case "serial":
      return (a, b) =>
        num(a.serial_number, Infinity) - num(b.serial_number, Infinity) ||
        num(b.fmv, -Infinity) - num(a.fmv, -Infinity)
    case "player":
      return (a, b) =>
        str(a.player_name).localeCompare(str(b.player_name)) ||
        num(a.serial_number, Infinity) - num(b.serial_number, Infinity)
    case "set":
      return (a, b) =>
        str(a.set_name).localeCompare(str(b.set_name)) ||
        num(a.series, Infinity) - num(b.series, Infinity) ||
        num(a.serial_number, Infinity) - num(b.serial_number, Infinity)
  }
}
