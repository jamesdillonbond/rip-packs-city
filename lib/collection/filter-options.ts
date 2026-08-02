// lib/collection/filter-options.ts
//
// Pure derivations lifted out of the useMemo bodies in
// app/(collections)/[collection]/collection/page.tsx so the filter-option and
// per-edition aggregation logic is unit-tested (the primary coverage gate
// measures lib/**). Behaviour is byte-identical to the inline blocks the page
// now calls; the page keeps the useMemo wrappers (for memoization) and delegates
// the computation here.

import type { MomentRow, CollectionSeriesEntry } from "@/lib/collection/types"
import { seriesFilterLabel, getLocked } from "@/lib/collection/helpers"
import { normalizeSetName, buildEditionScopeKey } from "@/lib/wallet-normalize"

// Distinct, sorted player names as filter options, "all" first.
export function buildPlayerOptions(rows: MomentRow[]): string[] {
  const s = new Set<string>()
  rows.forEach((r) => {
    if (r.playerName) s.add(r.playerName)
  })
  return ["all", ...Array.from(s).sort()]
}

// Distinct, sorted normalized set names as filter options, "all" first.
export function buildSetOptions(rows: MomentRow[]): string[] {
  const s = new Set<string>()
  rows.forEach((r) => {
    if (r.setName) s.add(normalizeSetName(r.setName))
  })
  return ["all", ...Array.from(s).sort()]
}

// Distinct, sorted tiers as filter options, "all" first.
export function buildRarityOptions(rows: MomentRow[]): string[] {
  const s = new Set<string>()
  rows.forEach((r) => {
    if (r.tier) s.add(r.tier)
  })
  return ["all", ...Array.from(s).sort()]
}

// Distinct, sorted series display labels as filter options, "all" first. Rows
// with no series, or whose label resolves to the "—" placeholder, are skipped.
export function buildSeriesOptions(
  rows: MomentRow[],
  seriesMap?: Map<number, CollectionSeriesEntry>,
): string[] {
  const s = new Set<string>()
  rows.forEach((r) => {
    if (r.series == null) return
    const label = seriesFilterLabel(r.series, seriesMap)
    if (label && label !== "—") s.add(label)
  })
  return ["all", ...Array.from(s).sort()]
}

// Per-edition owned/locked counts, keyed by the edition scope key. Drives the
// "N owned (M locked)" edition rollups and the dup filter.
export function buildBatchEditionStats(
  rows: MomentRow[],
): Map<string, { owned: number; locked: number }> {
  const map = new Map<string, { owned: number; locked: number }>()
  for (const row of rows) {
    const key = buildEditionScopeKey({
      editionKey: row.editionKey,
      setName: row.setName,
      playerName: row.playerName,
      parallel: row.parallel,
      subedition: row.subedition,
    })
    const current = map.get(key) ?? { owned: 0, locked: 0 }
    current.owned += 1
    if (getLocked(row)) current.locked += 1
    map.set(key, current)
  }
  return map
}

// Lowercased pack-title -> count lookup, summing counts across any duplicate
// titles. (The `packsByTitle` map already keys by title, but building the lookup
// this way keeps it robust to case-variant duplicate keys.)
export function buildPackLookup(packsByTitle: Record<string, number>): Map<string, number> {
  const map = new Map<string, number>()
  if (!Object.keys(packsByTitle).length) return map
  for (const [title, count] of Object.entries(packsByTitle)) {
    const lowerTitle = title.toLowerCase()
    map.set(lowerTitle, (map.get(lowerTitle) ?? 0) + count)
  }
  return map
}

// Pack count for a set name via substring match (either direction) against the
// lowercased pack-title lookup. Returns the first match's count, else 0.
export function getPackCount(packLookup: Map<string, number>, setName: string): number {
  if (!packLookup.size) return 0
  const normalizedSet = normalizeSetName(setName).toLowerCase()
  for (const [title, count] of packLookup.entries()) {
    if (title.includes(normalizedSet) || normalizedSet.includes(title)) return count
  }
  return 0
}

// Up to 3 nearly-complete sets (1-3 missing, >= 50% complete), sorted by fewest
// missing first — the "you're this close" nudge on the collection page.
export function nearCompleteSets<
  T extends { missingCount: number; completionPct: number },
>(sets: T[] | null | undefined): T[] {
  if (!sets) return []
  return sets
    .filter((s) => s.missingCount >= 1 && s.missingCount <= 3 && s.completionPct >= 50)
    .sort((a, b) => a.missingCount - b.missingCount)
    .slice(0, 3)
}
