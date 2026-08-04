// analytics-fmv-dashboard-compute — pure formatting / threshold / bucketing /
// query-string logic lifted out of components/analytics/FmvDashboard.tsx so it
// lands under the vitest coverage `include` (lib/**), which does NOT measure
// components/**. No React/JSX, no browser globals — behavior is identical to
// the inline code it replaced.

import type {
  FmvConfidence,
  FmvPipelineCollectionStats,
  FmvTierPulseRow,
  FmvTopMoverRow,
} from "@/lib/analytics-types"

export const FMV_COLLECTIONS: Array<{ key: string; label: string }> = [
  { key: "topshot", label: "Top Shot" },
  { key: "allday", label: "All Day" },
  { key: "pinnacle", label: "Pinnacle" },
  { key: "golazos", label: "Golazos" },
  { key: "ufc", label: "UFC Strike" },
]

export const COLLECTION_LABEL: Record<string, string> = {
  topshot: "Top Shot",
  allday: "All Day",
  pinnacle: "Pinnacle",
  golazos: "Golazos",
  ufc: "UFC Strike",
}

// analytics_fmv_top_movers may not have full coverage for newer collections.
// Hide the Top Movers card for these until we verify the RPC accepts them.
export const TOP_MOVERS_UNSUPPORTED = new Set<string>([
  "pinnacle",
  "golazos",
  "ufc",
])

export const WINDOW_OPTIONS: Array<{ value: 1 | 7 | 30; label: string }> = [
  { value: 1, label: "1 day" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
]

export const MIN_FMV_OPTIONS = [5, 25, 100, 500]
export const LIMIT_OPTIONS = [25, 50, 100]

export const TIER_ORDER: string[] = [
  "Common",
  "Fandom",
  "Rare",
  "Legendary",
  "Ultimate",
]
export const TIER_COLOR: Record<string, string> = {
  Common: "#a1a1aa",
  Fandom: "#60A5FA",
  Rare: "#22D3EE",
  Legendary: "#F59E0B",
  Ultimate: "#F43F5E",
  Other: "#52525b",
}

export const CONFIDENCE_STYLE: Record<
  FmvConfidence,
  { label: string; cls: string }
> = {
  HIGH: {
    label: "High",
    cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  },
  MEDIUM: {
    label: "Med",
    cls: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  },
  LOW: {
    label: "Low",
    cls: "border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] text-[color:var(--rpc-text-secondary)]",
  },
  ASK_ONLY: {
    label: "Ask only",
    cls: "border-rose-500/40 bg-rose-500/10 text-rose-400",
  },
  SALES_ONLY: {
    label: "Sales only",
    cls: "border-sky-500/40 bg-sky-500/10 text-sky-400",
  },
  STALE: {
    // Semantic colour (orange = aged/caution), not a raw neutral — keeps the
    // badge brand-token-clean and distinct from amber (MEDIUM) / the grey LOW.
    label: "Stale",
    cls: "border-orange-500/40 bg-orange-500/10 text-orange-400",
  },
  NO_DATA: {
    label: "No data",
    cls: "border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] text-[color:var(--rpc-text-ghost)]",
  },
}

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(2)}`
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

export function formatPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `${n.toFixed(digits)}%`
}

export function formatChangePct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const sign = n >= 0 ? "+" : ""
  return `${sign}${n.toFixed(1)}%`
}

export function formatChangeUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const sign = n >= 0 ? "+" : "-"
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`
  return `${sign}$${abs.toFixed(2)}`
}

export function formatMinutesAgo(mins: number | null | undefined): string {
  if (mins == null || !Number.isFinite(mins)) return "—"
  const m = Math.max(0, Math.floor(mins))
  if (m < 1) return "just now"
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

// True when an edition_id is a real UUID and can be linked to /edition/<id>.
export function isLinkableEditionId(editionId: string | null | undefined): boolean {
  return UUID_RE.test(editionId || "")
}

// Resolve a confidence value to its badge style, falling back to LOW for any
// unexpected value (mirrors `CONFIDENCE_STYLE[value] ?? CONFIDENCE_STYLE.LOW`).
export function resolveConfidenceStyle(
  value: FmvConfidence | null | undefined
): { label: string; cls: string } | null {
  if (!value) return null
  return CONFIDENCE_STYLE[value] ?? CONFIDENCE_STYLE.LOW
}

// Query-string collections param: the joined list, or "" when nothing active.
export function buildCollectionsQs(active: string[]): string {
  return active.length > 0 ? active.join(",") : ""
}

// Toggle a key in/out of a selection list (immutable).
export function toggleCollection(curr: string[], key: string): string[] {
  return curr.includes(key) ? curr.filter((c) => c !== key) : [...curr, key]
}

// Top Movers is hidden when there is at least one active collection AND every
// active collection is unsupported by analytics_fmv_top_movers.
export function shouldHideTopMovers(activeCollections: string[]): boolean {
  return (
    activeCollections.length > 0 &&
    activeCollections.every((c) => TOP_MOVERS_UNSUPPORTED.has(c))
  )
}

// A mover is "thin data" (single-sale / interpolated, possibly noise) when its
// current confidence is LOW and it had no 7d sales.
export function isThinMover(
  row: Pick<FmvTopMoverRow, "current_confidence" | "sales_count_7d">
): boolean {
  return row.current_confidence === "LOW" && row.sales_count_7d === 0
}

// Pipeline-health entries to render: filtered by the active-collection selection
// and restricted to the known FMV collections.
export function filterHealthEntries(
  collections: Record<string, FmvPipelineCollectionStats> | null | undefined,
  activeCollections: string[]
): Array<[string, FmvPipelineCollectionStats]> {
  if (!collections) return []
  return Object.entries(collections)
    .filter(([key]) =>
      activeCollections.length === 0 ? true : activeCollections.includes(key)
    )
    .filter(([key]) => FMV_COLLECTIONS.some((c) => c.key === key.toLowerCase()))
}

// Group tier-pulse rows by lowercase collection key, dropping rows with a
// null / non-positive total FMV.
export function groupTierPulseByCollection(
  rows: FmvTierPulseRow[]
): Map<string, FmvTierPulseRow[]> {
  const map = new Map<string, FmvTierPulseRow[]>()
  for (const r of rows) {
    if (r.total_fmv_usd == null || r.total_fmv_usd <= 0) continue
    const key = (r.collection || "").toLowerCase()
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(r)
  }
  return map
}

// Bucket one collection's rows into the canonical tier order (plus "Other"),
// summing counts/FMV, dropping an empty "Other" bucket, and returning both the
// visible buckets and the grand total FMV.
export function bucketCollectionTiers(collectionRows: FmvTierPulseRow[]): {
  visible: FmvTierPulseRow[]
  total: number
} {
  const tierBuckets = new Map<string, FmvTierPulseRow>()
  for (const r of collectionRows) {
    const tierKey = TIER_ORDER.includes(r.tier ?? "") ? r.tier! : "Other"
    const existing = tierBuckets.get(tierKey)
    if (!existing) {
      tierBuckets.set(tierKey, { ...r, tier: tierKey })
    } else {
      existing.edition_count += r.edition_count
      existing.total_fmv_usd += r.total_fmv_usd
      existing.high_conf_count += r.high_conf_count
      existing.low_conf_count += r.low_conf_count
    }
  }
  const orderedTiers = [...TIER_ORDER, "Other"]
    .map((t) => tierBuckets.get(t))
    .filter(Boolean) as FmvTierPulseRow[]
  const visible = orderedTiers.filter(
    (r) => r.tier !== "Other" || r.edition_count > 0
  )
  const total = visible.reduce((s, r) => s + (r.total_fmv_usd ?? 0), 0)
  return { visible, total }
}

// Share of a tier's FMV against the collection grand total, as a percent.
export function tierSharePct(totalFmv: number, grandTotal: number): number {
  return grandTotal > 0 ? (totalFmv / grandTotal) * 100 : 0
}

// Percent of a tier's editions that are high-confidence.
export function pctHighConf(highConfCount: number, editionCount: number): number {
  return editionCount > 0 ? (highConfCount / editionCount) * 100 : 0
}
