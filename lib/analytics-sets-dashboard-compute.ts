// analytics-sets-dashboard-compute — pure formatting / bucketing / sort /
// aggregation logic lifted out of components/analytics/SetsDashboard.tsx so it
// lands under the vitest coverage `include` (lib/**), which does NOT measure
// components/**. No React/JSX, no browser globals — behavior is identical to
// the inline code it replaced.

import type {
  SetsDirectorySort,
  SetsSeriesOverviewRow,
} from "@/lib/analytics-types"
import { isUnmappedSeriesLabel } from "@/lib/analytics/series-labels"

export const SET_COLLECTIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "topshot", label: "Top Shot" },
  { key: "allday", label: "NFL All Day" },
  { key: "golazos", label: "LaLiga Golazos" },
  { key: "pinnacle", label: "Disney Pinnacle" },
  { key: "ufc", label: "UFC Strike" },
] as const

export const COLLECTION_LABEL: Record<string, string> = {
  topshot: "Top Shot",
  allday: "All Day",
  golazos: "Golazos",
  pinnacle: "Pinnacle",
  ufc: "UFC",
}

export const COLLECTION_COLOR: Record<string, string> = {
  topshot: "#a78bfa",
  allday: "#34d399",
  golazos: "#22d3ee",
  pinnacle: "#f472b6",
  ufc: "#f97316",
}

export const TIER_ORDER = [
  "common",
  "fandom",
  "rare",
  "legendary",
  "ultimate",
] as const
export const TIER_LABEL: Record<(typeof TIER_ORDER)[number], string> = {
  common: "Common",
  fandom: "Fandom",
  rare: "Rare",
  legendary: "Legendary",
  ultimate: "Ultimate",
}
export const TIER_COLOR: Record<(typeof TIER_ORDER)[number], string> = {
  common: "#a1a1aa",
  fandom: "#60A5FA",
  rare: "#22D3EE",
  legendary: "#F59E0B",
  ultimate: "#F43F5E",
}

export const SORT_OPTIONS: Array<{ value: SetsDirectorySort; label: string }> = [
  { value: "value_desc", label: "Value" },
  { value: "newest", label: "Newest" },
  { value: "name_asc", label: "Name" },
  { value: "completion_desc", label: "Completion" },
]

export const COVERAGE_OPTIONS = [0, 50, 75, 100]
export const LIMIT_OPTIONS = [50, 100, 200]

// Hand-rolled chronological rank for the series-overview x-axis order.
export const SERIES_RANK: Record<string, number> = {
  "Series 1": 1,
  "Series 2": 2,
  "Summer 2021": 3,
  "Series 3": 4,
  "Series 4": 5,
  "Series 2023-24": 6,
  "Series 2024-25": 7,
  "Series 2025-26": 8,
}

export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(2)}`
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

export function formatPct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `${n.toFixed(digits)}%`
}

// CoverageBar clamps its input into [0, 100].
export function clampPct(pct: number): number {
  return Math.max(0, Math.min(100, pct))
}

// Collection chip label / color resolvers (case-insensitive, with fallbacks).
export function collectionChipLabel(collection: string): string {
  return COLLECTION_LABEL[collection.toLowerCase()] ?? collection
}
export function collectionChipColor(collection: string): string {
  return COLLECTION_COLOR[collection.toLowerCase()] ?? "#a1a1aa"
}

// Total editions across the canonical tiers for a summary card's tier mix.
export function tierMixTotal(tierBreakdown: Record<string, number>): number {
  return TIER_ORDER.reduce((s, t) => s + (tierBreakdown[t] || 0), 0)
}

// Share of one tier against the tier-mix total, as a percent.
export function tierMixPct(count: number, total: number): number {
  return total > 0 ? (count / total) * 100 : 0
}

// Coverage percent = editions-with-fmv / editions, as a percent (0 when empty).
export function coveragePct(
  withFmv: number | null | undefined,
  total: number | null | undefined
): number {
  const t = total || 0
  const w = withFmv || 0
  return t > 0 ? (w / t) * 100 : 0
}

// Average of accumulated medians, or null when no medians were counted.
export function medianAverage(
  medianTotal: number,
  medianCount: number
): number | null {
  return medianCount > 0 ? medianTotal / medianCount : null
}

// Query-string collections param: the joined list, or "" when nothing active.
export function buildCollectionsQs(active: string[]): string {
  return active.length > 0 ? active.join(",") : ""
}

// Toggle a key in/out of a selection list (immutable).
export function toggleCollection(curr: string[], key: string): string[] {
  return curr.includes(key) ? curr.filter((c) => c !== key) : [...curr, key]
}

export interface SeriesChart {
  chartData: Array<Record<string, number | string>>
  labels: string[]
}

// Build the stacked-bar chart data + ordered label list from series rows.
// Real series sort into canonical chronological order (SERIES_RANK, then
// locale), and Misc / Unmapped labels are appended last.
export function buildSeriesChart(rows: SetsSeriesOverviewRow[]): SeriesChart {
  const labelMap = new Map<string, Record<string, number>>()
  for (const r of rows) {
    if (!r.series_label) continue
    const existing = labelMap.get(r.series_label) ?? {}
    existing[r.collection] =
      (existing[r.collection] ?? 0) + (r.total_series_fmv_robust || 0)
    labelMap.set(r.series_label, existing)
  }

  // Order: real series first (in canonical order), Misc / Unmapped last.
  const real = Array.from(labelMap.keys()).filter(
    (l) => !isUnmappedSeriesLabel(l)
  )
  real.sort((a, b) => {
    const ra = SERIES_RANK[a] ?? 99
    const rb = SERIES_RANK[b] ?? 99
    if (ra !== rb) return ra - rb
    return a.localeCompare(b)
  })
  const ordered = [...real]
  for (const l of labelMap.keys()) {
    if (isUnmappedSeriesLabel(l)) ordered.push(l)
  }

  const data = ordered.map((label) => {
    const entry: Record<string, number | string> = { series_label: label }
    const buckets = labelMap.get(label) ?? {}
    for (const c of Object.keys(buckets)) {
      entry[c] = buckets[c]
    }
    return entry
  })

  return { chartData: data, labels: ordered }
}

// Distinct set of collections present across the series rows.
export function seriesCollectionsPresent(
  rows: SetsSeriesOverviewRow[]
): string[] {
  const set = new Set<string>()
  for (const r of rows) set.add(r.collection)
  return Array.from(set)
}

export interface SeriesTableRow {
  series_label: string
  set_count: number
  edition_count: number
  edition_count_with_fmv: number
  total_robust: number
  median_total: number
  median_count: number
}

// Aggregate series rows into a per-label rollup, ordered to match `labels`.
export function buildSeriesTableRows(
  rows: SetsSeriesOverviewRow[],
  labels: string[]
): SeriesTableRow[] {
  const map = new Map<string, SeriesTableRow>()
  for (const r of rows) {
    const existing = map.get(r.series_label) ?? {
      series_label: r.series_label,
      set_count: 0,
      edition_count: 0,
      edition_count_with_fmv: 0,
      total_robust: 0,
      median_total: 0,
      median_count: 0,
    }
    existing.set_count += r.set_count || 0
    existing.edition_count += r.edition_count || 0
    existing.edition_count_with_fmv += r.edition_count_with_fmv || 0
    existing.total_robust += r.total_series_fmv_robust || 0
    if (r.median_edition_fmv != null && Number.isFinite(r.median_edition_fmv)) {
      existing.median_total += r.median_edition_fmv
      existing.median_count += 1
    }
    map.set(r.series_label, existing)
  }
  return labels.map((l) => map.get(l)).filter(Boolean) as SeriesTableRow[]
}
