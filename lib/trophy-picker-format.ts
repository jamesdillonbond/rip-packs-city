// trophy-picker-format — pure tier/format/filter-sort logic lifted out of
// components/profile/TrophyPickerModal.tsx so it lands under the vitest coverage
// `include` (lib/**), which does NOT measure components/**. No React/JSX, no
// browser globals — behavior is identical to the inline code it replaced.

export type TrophyTierFilter =
  | 'ALL'
  | 'ULTIMATE'
  | 'LEGENDARY'
  | 'RARE'
  | 'FANDOM'
  | 'UNCOMMON'
  | 'COMMON'

// The non-"ALL" tiers, in rarity order (rarest first).
export type NormalizedTier = Exclude<TrophyTierFilter, 'ALL'>

export type TrophySortKey = 'fmv_desc' | 'serial_asc' | 'tier_rank'

export const TIER_ORDER: NormalizedTier[] = [
  'ULTIMATE',
  'LEGENDARY',
  'RARE',
  'FANDOM',
  'UNCOMMON',
  'COMMON',
]

// Structural minimum a moment needs to be filtered/sorted/named. The component's
// richer PickerMoment satisfies this by shape, so nothing needs to import back a
// heavyweight type.
export interface TrophyMomentLike {
  moment_id: string
  player_name?: string | null
  character_name?: string | null
  edition_name?: string | null
  set_name?: string | null
  team_name?: string | null
  tier?: string | null
  serial_number?: number | null
  fmv_usd?: number | null
}

// Maps a raw tier string (any casing, possibly a longer label) to one of the
// canonical tiers, or null when it matches none.
export function normalizeTier(tier?: string | null): NormalizedTier | null {
  if (!tier) return null
  const t = tier.toLowerCase()
  if (t.includes('ultimate')) return 'ULTIMATE'
  if (t.includes('legendary')) return 'LEGENDARY'
  if (t.includes('rare')) return 'RARE'
  if (t.includes('fandom')) return 'FANDOM'
  if (t.includes('uncommon')) return 'UNCOMMON'
  if (t.includes('common')) return 'COMMON'
  return null
}

export function tierColor(tier: NormalizedTier | null): string {
  switch (tier) {
    case 'ULTIMATE':
      return '#EC4899'
    case 'LEGENDARY':
      return '#F59E0B'
    case 'RARE':
      return '#818CF8'
    case 'FANDOM':
      return '#34D399'
    case 'UNCOMMON':
      return '#60A5FA'
    case 'COMMON':
      return '#9CA3AF'
    default:
      return '#6B7280'
  }
}

// $0 / $12.34 / $1,234 — thousands get comma-grouped and rounded, sub-$1k keeps
// two decimals, null renders an em-dash and a hard 0 renders "$0".
export function fmtUsd(n: number | null | undefined): string {
  if (n == null) return '—'
  if (!n) return '$0'
  if (n >= 1000) return '$' + Math.round(n).toLocaleString()
  return '$' + n.toFixed(2)
}

// Best available human name for a moment, falling back to its raw id.
export function displayName(m: TrophyMomentLike): string {
  return m.player_name || m.character_name || m.edition_name || m.moment_id
}

// Rank a normalized tier for the "tier_rank" sort — rarest first (index 0),
// unknown/null sinks to the bottom.
export function tierRank(tier: NormalizedTier | null): number {
  if (!tier) return 99
  const idx = TIER_ORDER.indexOf(tier)
  return idx === -1 ? 99 : idx
}

// The set of tiers actually present in a moment list, returned in rarity order —
// drives which filter chips render.
export function presentTiers(moments: TrophyMomentLike[] | null | undefined): NormalizedTier[] {
  if (!moments) return []
  const set = new Set<NormalizedTier>()
  for (const m of moments) {
    const t = normalizeTier(m.tier)
    if (t) set.add(t)
  }
  return TIER_ORDER.filter((t) => set.has(t))
}

// Apply the tier filter + free-text query, then sort. Preserves the exact
// tie-break rules of the inline reducer (secondary FMV-desc on serial/tier
// sorts). Returns a fresh array; the input is never mutated.
export function filterSortMoments<T extends TrophyMomentLike>(
  moments: T[] | null | undefined,
  sort: TrophySortKey,
  tierFilter: TrophyTierFilter,
  query: string,
): T[] {
  if (!moments) return []
  const q = query.trim().toLowerCase()
  const filtered = (
    tierFilter === 'ALL'
      ? moments.slice()
      : moments.filter((m) => normalizeTier(m.tier) === tierFilter)
  ).filter(
    (m) =>
      !q ||
      [displayName(m), m.set_name, m.team_name, m.character_name].some((s) =>
        (s ?? '').toLowerCase().includes(q),
      ),
  )
  filtered.sort((a, b) => {
    switch (sort) {
      case 'serial_asc': {
        const sa = a.serial_number ?? Number.POSITIVE_INFINITY
        const sb = b.serial_number ?? Number.POSITIVE_INFINITY
        if (sa !== sb) return sa - sb
        return (b.fmv_usd ?? 0) - (a.fmv_usd ?? 0)
      }
      case 'tier_rank': {
        const ra = tierRank(normalizeTier(a.tier))
        const rb = tierRank(normalizeTier(b.tier))
        if (ra !== rb) return ra - rb
        return (b.fmv_usd ?? 0) - (a.fmv_usd ?? 0)
      }
      case 'fmv_desc':
      default:
        return (b.fmv_usd ?? 0) - (a.fmv_usd ?? 0)
    }
  })
  return filtered
}
