// Pure computation helpers extracted from components/analytics/SalesDashboard.tsx.
// No React / JSX / browser-only globals — imported back into the component with
// zero behavior change so the branching logic is covered by the vitest ratchet.

import type { LoanWindow } from "@/components/analytics/FilterBar"
import type {
  SalesTimeseriesRow,
  AnalyticsTimeseriesRow,
} from "@/lib/analytics-types"

export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

export function formatPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—"
  if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

export function deltaPct(
  curr: number | null | undefined,
  prev: number | null | undefined
): number | null {
  if (curr == null || prev == null || !Number.isFinite(curr) || !Number.isFinite(prev)) return null
  if (prev <= 0) return null
  return Math.round(((curr - prev) / prev) * 1000) / 10
}

export function buildQs(window: LoanWindow, collections: string[]): string {
  const qs = new URLSearchParams()
  qs.set("window", window)
  if (collections.length > 0) qs.set("collections", collections.join(","))
  return qs.toString()
}

export function normalizeCollectionProp(prop?: string | string[] | null): string[] {
  if (!prop) return []
  if (Array.isArray(prop)) return prop.filter(Boolean)
  return prop
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

// VolumeChart was built for the loans payload (principal_usd / loan_count).
// The shape is identical otherwise, so we just re-key the sales rows.
export function reshapeForVolumeChart(rows: SalesTimeseriesRow[]): AnalyticsTimeseriesRow[] {
  return rows.map((r) => ({
    bucket: r.bucket,
    collection: r.collection,
    loan_count: r.sale_count,
    principal_usd: Number(r.volume_usd) || 0,
    repayment_usd: 0,
  }))
}

export function salesWindowLabel(window: LoanWindow): string {
  switch (window) {
    case "l7":
      return "Last 7 days"
    case "l30":
      return "Last 30 days"
    case "l90":
      return "Last 90 days"
    case "ytd":
      return "Year to date"
    case "y2026":
      return "2026"
    case "y2025":
      return "2025"
    default:
      return "All time"
  }
}
