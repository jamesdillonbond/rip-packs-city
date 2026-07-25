// analytics-loans-dashboard-compute — pure formatting / delta / query-string /
// label logic lifted out of components/analytics/LoansDashboard.tsx so it lands
// under the vitest coverage `include` (lib/**), which does NOT measure
// components/**. No React/JSX, no browser globals — behavior is identical to
// the inline code it replaced.

// LoanWindow mirrors the union exported by components/analytics/FilterbBar.tsx.
// Redeclared here (structurally identical string-literal union) so this pure
// module doesn't import a "use client" component. Values assign both ways.
export type LoanWindow = "l7" | "l30" | "l90" | "ytd" | "y2026" | "y2025" | "all"

// ── Number / percent formatters (branch-heavy) ──────────────────────────────

export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

export function formatPct(n: number | null | undefined, fallback = "—"): string {
  if (n == null || !Number.isFinite(n)) return fallback
  return `${n.toFixed(1)}%`
}

// Compute % delta between current and prior values. Returns null when there
// is no usable signal — caller should suppress the indicator entirely in
// that case (we don't want to render "+0%" or "—" as a fake delta).
export function deltaPct(curr: number | null | undefined, prev: number | null | undefined): number | null {
  if (curr == null || prev == null || !Number.isFinite(curr) || !Number.isFinite(prev)) return null
  if (prev <= 0) return null
  return Math.round(((curr - prev) / prev) * 1000) / 10
}

// ── Query-string + prop normalization ───────────────────────────────────────

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

// ── Window label map ────────────────────────────────────────────────────────

export function windowLabel(window: LoanWindow): string {
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

// ── APR / term-rate resolution ──────────────────────────────────────────────

// A minimal shape carrying the interchangeable rate fields. The summary RPC
// returns avg_apr (annualized) and avg_term_rate (rate-over-term); older
// payloads carried avg_interest_rate. Resolution prefers apr → term_rate →
// interest_rate, matching the component's fallback chain.
export interface AprRateSource {
  avg_apr?: number | null
  avg_term_rate?: number | null
  avg_interest_rate?: number | null
}

export function pickAprRate(w: AprRateSource | null | undefined): number | null {
  if (!w) return null
  if (w.avg_apr != null) return w.avg_apr
  if (w.avg_term_rate != null) return w.avg_term_rate
  return w.avg_interest_rate ?? null
}

// Convert a fractional rate (e.g. 0.123) to a percentage rounded to one
// decimal (12.3); null-safe.
export function ratePctRounded(rate: number | null | undefined): number | null {
  if (rate == null) return null
  return Math.round(rate * 100 * 10) / 10
}

// The "over term" term-rate percent: prefers avg_term_rate, falls back to
// avg_interest_rate, both scaled and rounded to one decimal. null when neither
// is present.
export function termRatePctRounded(w: AprRateSource | null | undefined): number | null {
  if (!w) return null
  if (w.avg_term_rate != null) return Math.round(w.avg_term_rate * 100 * 10) / 10
  if (w.avg_interest_rate != null) return Math.round(w.avg_interest_rate * 100 * 10) / 10
  return null
}

// ── Subtitle / caption builders ─────────────────────────────────────────────

// APR card sublabel — surfaces the raw term rate (and optional avg term days)
// so both the annualized metric and the lender's actual quote are visible.
export function aprSublabel(
  termRatePct: number | null | undefined,
  avgTermDays: number | null | undefined,
): string | undefined {
  if (termRatePct == null) return undefined
  if (avgTermDays == null) return `${termRatePct.toFixed(1)}% over term`
  return `${termRatePct.toFixed(1)}% over ${Math.round(avgTermDays)}d term`
}

// Lender/borrower KPI sublabel: "<pct>% returning" when a repeat-pct is present
// and there is at least one unique originator, else "<n> originators", else
// undefined (no summary yet).
export function repeatSubtitle(
  repeatPct: number | null | undefined,
  uniqueCount: number | null | undefined,
  hasSummary: boolean,
): string | undefined {
  if (repeatPct != null && uniqueCount != null && uniqueCount > 0) {
    return `${formatPct(repeatPct)} returning`
  }
  if (hasSummary) {
    return `${formatNumber(uniqueCount)} originators`
  }
  return undefined
}

// Limbo card "data freshness" caption: hours since last terminal event,
// rendered in hours (<24h) or days. null when no freshness value.
export function limboFreshnessLabel(hours: number | null | undefined): string | null {
  if (hours == null) return null
  if (hours < 24) return `${hours.toFixed(1)} hours since last terminal event`
  return `${(hours / 24).toFixed(1)} days since last terminal event`
}
