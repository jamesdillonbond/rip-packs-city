// analytics-pulse-dashboard-compute — pure formatting / bucketing / dedupe /
// summarization logic lifted out of components/analytics/PulseDashboard.tsx so
// it lands under the vitest coverage `include` (lib/**), which does NOT measure
// components/**. No React/JSX, no browser globals — behavior is identical to
// the inline code it replaced. Any current-time dependency is injected via a
// `now` parameter (default Date.now()) so callers stay runtime-identical.

import type {
  PulseActivityKind,
  PulseActivityRow,
  PulseHourlyRow,
} from "@/lib/analytics-types"

// ── Number / price formatters (branch-heavy) ────────────────────────────────

export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

export function formatPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
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

// Relative time label. `now` is injectable so the pure branch logic is
// testable; the component omits it, keeping the original Date.now() behavior.
export function relativeFromNow(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return "—"
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return "—"
  const diff = now - t
  if (diff < 0) return "just now"
  if (diff < 5_000) return "just now"
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`
  if (diff < 30 * 24 * 60 * 60_000) return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`
  return new Date(iso).toLocaleDateString()
}

// ── Address helpers ─────────────────────────────────────────────────────────

export function truncateAddr(addr: string | null | undefined): string {
  if (!addr) return ""
  const a = String(addr).toLowerCase()
  if (!a.startsWith("0x") || a.length <= 10) return a
  return a.slice(0, 6) + "…" + a.slice(-4)
}

export function isLinkableAddr(a: string | null | undefined): a is string {
  return !!a && /^0x[0-9a-f]{16}$/i.test(a)
}

// ── Collection label map + activity-row summarization ───────────────────────

export const COLLECTION_LABEL: Record<string, string> = {
  topshot: "Top Shot",
  allday: "All Day",
  golazos: "Golazos",
  pinnacle: "Pinnacle",
  ufc: "UFC",
}

export function summarizeKind(row: PulseActivityRow): string {
  const d = (row.details ?? {}) as Record<string, unknown>
  const collectionLabel = COLLECTION_LABEL[row.collection?.toLowerCase()] ?? row.collection
  switch (row.kind) {
    case "loan_originated": {
      const term = d.term_days != null ? `${d.term_days}d` : "—"
      const apr = d.apr_pct != null ? `${Number(d.apr_pct).toFixed(0)}% APR` : ""
      const principal = formatUsd(row.amount_usd ?? 0)
      const tail = apr ? ` for ${term} at ${apr}` : ` for ${term}`
      return `Loan originated: ${principal}${tail} · ${collectionLabel}`
    }
    case "loan_repaid": {
      const repaid = formatUsd(row.amount_usd ?? 0)
      const principal = d.principal_usd != null ? formatUsd(Number(d.principal_usd)) : null
      const tail = principal ? ` (principal ${principal})` : ""
      return `Loan repaid: ${repaid}${tail} · ${collectionLabel}`
    }
    case "loan_settled": {
      const principal = d.principal_usd != null ? formatUsd(Number(d.principal_usd)) : formatUsd(row.amount_usd ?? 0)
      return `Loan defaulted: ${principal} settled to lender · ${collectionLabel}`
    }
    case "sale": {
      const price = formatUsd(row.amount_usd ?? 0)
      const marketplace = String(d.marketplace ?? "").toLowerCase() || "marketplace"
      const serial =
        d.serial_number != null && Number.isFinite(Number(d.serial_number))
          ? ` · #${d.serial_number}`
          : ""
      return `Sale: ${price} on ${marketplace}${serial} · ${collectionLabel}`
    }
    default:
      return collectionLabel || ""
  }
}

// Top Shot's centralized marketplace doesn't expose participant wallets; we
// surface a small badge on those rows so the missing addresses don't read as
// a bug.
export function isAnonymousSale(row: PulseActivityRow): boolean {
  if (row.kind !== "sale") return false
  const marketplace = String((row.details as Record<string, unknown>)?.marketplace ?? "").toLowerCase()
  if (marketplace === "topshot") return true
  return !row.primary_addr && !row.counterparty
}

// Stable dedupe key for an activity row (tx hash → listing resource id →
// composite fallback).
export function activityRowKey(row: PulseActivityRow): string {
  const d = (row.details ?? {}) as Record<string, unknown>
  return (
    String(d.tx_hash ?? "") ||
    String(d.listing_resource_id ?? "") ||
    `${row.occurred_at}-${row.kind}-${row.primary_addr ?? "anon"}`
  )
}

// ── Hourly bucket reshaping (sort + normalize) ──────────────────────────────

export interface HourlyPoint {
  hour: string
  hourLabel: string
  loan_count: number
  sale_count: number
}

export function reshapeHourly(rows: PulseHourlyRow[]): HourlyPoint[] {
  return rows
    .slice()
    .sort((a, b) => a.hour.localeCompare(b.hour))
    .map((r) => {
      const d = new Date(r.hour)
      const label = Number.isFinite(d.getTime())
        ? `${d.getUTCHours().toString().padStart(2, "0")}:00`
        : r.hour.slice(11, 16)
      return {
        hour: r.hour,
        hourLabel: label,
        loan_count: Number(r.loan_count) || 0,
        sale_count: Number(r.sale_count) || 0,
      }
    })
}

// ── Kind filter config + resolver ───────────────────────────────────────────

export type PulseKindFilterKey = "all" | "loans" | "sales"

export const KIND_FILTERS: Array<{
  key: PulseKindFilterKey
  label: string
  kinds: PulseActivityKind[] | null
}> = [
  { key: "all", label: "All", kinds: null },
  {
    key: "loans",
    label: "Loans",
    kinds: ["loan_originated", "loan_repaid", "loan_settled"],
  },
  { key: "sales", label: "Sales", kinds: ["sale"] },
]

// The activity-kind array for a given filter key, or null for "all".
export function kindsForFilter(key: PulseKindFilterKey): PulseActivityKind[] | null {
  return KIND_FILTERS.find((k) => k.key === key)?.kinds ?? null
}
