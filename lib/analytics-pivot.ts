// Pure chart-shaping pivots for the collection analytics page
// (app/(collections)/[collection]/analytics/page.tsx). Each turns flat daily rows
// into date-keyed buckets for a stacked chart, drops UNKNOWN, and zero-fills so
// every series/tier has a value on every date (a missing key leaves a gap in the
// chart). Extracted so the bucketing/zero-fill/sort is unit-tested. Parametrized
// over minimal row shapes so the page's own row types stay assignable.

import { seriesLabel } from "@/lib/series-label"

export interface PivotTierRow {
  date: string
  tier: string
  sale_count: number
  volume: number
  avg_price: number
}

/**
 * Pivot daily per-tier rows into `{ date, <tier>: value, ... }` buckets for the
 * chosen numeric field. Drops null/UNKNOWN tiers, sorts by date ascending, and
 * zero-fills every tier on every date so the stacked chart has no gaps.
 */
export function pivotDailyTier<T extends "sale_count" | "volume" | "avg_price">(
  rows: PivotTierRow[] | undefined,
  field: T,
): { data: Array<Record<string, string | number>>; tiers: string[] } {
  if (!rows || rows.length === 0) return { data: [], tiers: [] }
  const byDate = new Map<string, Record<string, string | number>>()
  const tierSet = new Set<string>()
  for (const r of rows) {
    if (!r.tier || r.tier === "UNKNOWN") continue
    tierSet.add(r.tier)
    const bucket = byDate.get(r.date) ?? { date: r.date }
    bucket[r.tier] = Number(r[field] ?? 0)
    byDate.set(r.date, bucket)
  }
  const data = Array.from(byDate.values()).sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  )
  const tiers = Array.from(tierSet)
  for (const row of data) {
    for (const t of tiers) if (row[t] === undefined) row[t] = 0
  }
  return { data, tiers }
}

export interface PivotSeriesRow {
  date: string
  series: number | null
  volume: number
}

/**
 * Pivot daily per-series rows into `{ date, <seriesLabel>: summedVolume, ... }`
 * buckets, keeping only the `topSeriesKeys` (by seriesLabel), summing volume per
 * (date, series-label), sorting by date, and zero-filling each top key.
 */
export function pivotDailySeries(
  rows: PivotSeriesRow[] | undefined,
  topSeriesKeys: string[],
): Array<Record<string, string | number>> {
  if (!rows || rows.length === 0) return []
  const byDate = new Map<string, Record<string, string | number>>()
  for (const r of rows) {
    const key = seriesLabel(r.series)
    if (!topSeriesKeys.includes(key)) continue
    const bucket = byDate.get(r.date) ?? { date: r.date }
    bucket[key] = Number(bucket[key] ?? 0) + Number(r.volume ?? 0)
    byDate.set(r.date, bucket)
  }
  const data = Array.from(byDate.values()).sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  )
  for (const row of data) {
    for (const k of topSeriesKeys) if (row[k] === undefined) row[k] = 0
  }
  return data
}
