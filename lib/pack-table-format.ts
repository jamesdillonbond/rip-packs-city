// pack-table-format — pure formatting/threshold/sort logic lifted out of
// components/packs/PackTable.tsx so it lands under the vitest coverage `include`
// (lib/**), which does NOT measure components/**. No React/JSX, no browser
// globals — behavior is identical to the inline code it replaced.

import type { ChipStyle } from '@/lib/tier-style'
import { humanizeLabel } from '@/lib/format'

// Tier rarity rank for the "Tier" column sort (rarity, not alphabetical —
// Pack audit B6). common < fandom < rare < legendary < ultimate; UFC tiers
// map by rough rarity equivalence.
export const TIER_RANK: Record<string, number> = {
  COMMON: 1,
  FANDOM: 2,
  UNCOMMON: 3,
  CONTENDER: 3,
  RARE: 4,
  EPIC: 5,
  CHALLENGER: 5,
  LEGENDARY: 6,
  ULTIMATE: 7,
}

export function tierRank(raw: string | null | undefined): number {
  if (!raw) return 0
  return TIER_RANK[raw.toUpperCase()] ?? 0
}

export const COVERAGE_NULL: ChipStyle = {
  background: 'rgba(100,116,139,0.15)',
  border: '1px solid rgba(100,116,139,0.4)',
  color: 'rgb(148,163,184)',
}
export const COVERAGE_LOW: ChipStyle = {
  background: 'rgba(249,115,22,0.15)',
  border: '1px solid rgba(249,115,22,0.4)',
  color: 'rgb(253,186,116)',
}
export const COVERAGE_HIGH: ChipStyle = {
  background: 'rgba(16,185,129,0.15)',
  border: '1px solid rgba(16,185,129,0.4)',
  color: 'rgb(110,231,183)',
}

export function coverageChipClass(cov: number | null): ChipStyle {
  if (cov == null) return COVERAGE_NULL
  if (cov < 0.6) return COVERAGE_LOW
  return COVERAGE_HIGH
}

export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `$${n.toFixed(2)}`
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

// On a heavily-depleted pool (≥90% sold out) the bold green EV margin (e.g.
// +1929%) is a survivor-bias artifact — the remaining editions are the few
// high-FMV survivors, so the headline number is not an achievable edge. Mute it
// to a neutral color there so the headline matches the depletion caveat chip
// instead of screaming a fake green margin. (Item 11, 2026-06-26 audit.)
export const HEAVY_DEPLETION_THRESHOLD = 0.9

export function marginClass(pct: number | null, poolDepletionPct?: number | null): string {
  if (pct == null) return 'text-[color:var(--rpc-text-muted)]'
  if (
    pct > 0 &&
    poolDepletionPct != null &&
    Number.isFinite(poolDepletionPct) &&
    poolDepletionPct >= HEAVY_DEPLETION_THRESHOLD
  ) {
    return 'text-[color:var(--rpc-text-secondary)]'
  }
  if (pct > 0) return 'text-emerald-400'
  if (pct < 0) return 'text-red-400'
  return 'text-[color:var(--rpc-text-secondary)]'
}

// Slots cell: render the integer when meaningful, otherwise fall back to the
// pack_type label (Bundle, Reward, Chance Hit, etc) or an em-dash. Several
// pack types in the catalog (Grail Seeker, certain Fast Break runs) ship a
// legitimate null/0 from the source — rendering "0" is misleading.
export function fmtSlots(slots: number | null, packType?: string | null): string {
  if (slots != null && slots > 0) return String(slots)
  // humanizeLabel so a raw `in_season_premium` renders "In Season Premium"
  // rather than the literal "In_season_premium" (capitalize-first alone left the
  // underscores in — the Golazos pack-page defect fixed 2026-07-25).
  const label = humanizeLabel(packType)
  if (label) return label
  return '—'
}

export const POOL_DEPLETION_THRESHOLD = 0.7

// Surface pool depletion as a "🔥 X/N remain" chip when ≥70% of the drop
// pool's editions have remaining=0. Mathematically EV is correct, but it's
// dominated by a few survivors — sophisticated buyers want to know.
export function depletionChip(
  poolDepletionPct: number | null | undefined,
  editionCount: number | null | undefined,
): { label: string; surviving: number; total: number } | null {
  if (poolDepletionPct == null || !Number.isFinite(poolDepletionPct)) return null
  if (poolDepletionPct < POOL_DEPLETION_THRESHOLD) return null
  if (editionCount == null || editionCount <= 0) return null
  const surviving = Math.max(1, Math.round(editionCount * (1 - poolDepletionPct)))
  return { label: `🔥 ${surviving}/${editionCount} remain`, surviving, total: editionCount }
}

// Comparator for the PackTable column sort. Extracted verbatim from the inline
// `arr.sort` closure so it can be unit-tested.
//   - null/undefined always sort to the end regardless of direction.
//   - when isTierSort, the two values are compared by rarity rank (tierRank),
//     otherwise numerically (numbers) or case-insensitively (strings).
export function comparePackValues(
  av: unknown,
  bv: unknown,
  isTierSort: boolean,
  sortDir: 'asc' | 'desc',
): number {
  // Null/undefined values always sort to the end regardless of direction
  // — the asymmetry the previous comparator had (-Infinity sorted to the
  // top in asc order) made packs missing EV crowd the top of the
  // "EV margin asc" / "remaining asc" views, which isn't useful.
  const aNull = av == null
  const bNull = bv == null
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  let an: string | number
  let bn: string | number
  if (isTierSort) {
    an = tierRank(String(av))
    bn = tierRank(String(bv))
  } else {
    an = typeof av === 'number' ? av : String(av).toLowerCase()
    bn = typeof bv === 'number' ? bv : String(bv).toLowerCase()
  }
  if (an === bn) return 0
  if (sortDir === 'desc') return an > bn ? -1 : 1
  return an < bn ? -1 : 1
}

// Default sort direction when a new column header is clicked: title/tier open
// ascending (A→Z / least-rare-first reads naturally), everything else descending
// (biggest number first).
export function defaultSortDir(key: string): 'asc' | 'desc' {
  return key === 'title' || key === 'tier' ? 'asc' : 'desc'
}
