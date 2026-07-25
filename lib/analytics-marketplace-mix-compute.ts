// Pure computation lifted out of components/analytics/MarketplaceMix.tsx so it
// is visible to the coverage ratchet (components/** is not measured). No React,
// no JSX — the component imports these back and renders the result unchanged.
//
// The logic buckets indexed sale volume across the marketplaces we track
// (Top Shot centralized market, Flowty, on-chain Pinnacle), merging the
// pinnacle/on-chain alias, and folding any unknown source into an "other"
// slice. A regression here mis-labels or mis-sizes the stacked-bar slices.

export interface MarketplaceMixEntry {
  count: number
  usd: number
}

export type MarketplaceMixData = Record<string, MarketplaceMixEntry> | null | undefined

export interface MixSlice {
  key: string
  label: string
  count: number
  usd: number
  color: string
  className: string
}

/** Discriminated result so the component can branch its two distinct empty
 *  states (no data at all vs. data with zero volume) without duplicating the
 *  bucketing logic. */
export type MarketplaceMixResult =
  | { kind: "empty" }
  | { kind: "no-volume" }
  | { kind: "ok"; slices: MixSlice[]; total: number }

/** Known marketplace slices in render order. Both "on-chain" and "pinnacle"
 *  map to the same Pinnacle-direct slice; incoming "pinnacle" is normalized to
 *  "on-chain" during the merge so only the "on-chain" entry ever matches. */
export const KNOWN_MARKETPLACES: ReadonlyArray<{
  key: string
  label: string
  color: string
  className: string
}> = [
  { key: "topshot", label: "Top Shot marketplace", color: "#10b981", className: "bg-emerald-500" },
  { key: "flowty", label: "Flowty (NFTStorefrontV2)", color: "#a78bfa", className: "bg-violet-400" },
  { key: "on-chain", label: "Pinnacle direct", color: "#38bdf8", className: "bg-sky-400" },
  { key: "pinnacle", label: "Pinnacle direct", color: "#38bdf8", className: "bg-sky-400" },
]

// brand-exception: neutral chart-slice fill for the "other" volume bucket
export const OTHER_SLICE_COLOR = "#71717a"
export const OTHER_SLICE_CLASS = "bg-zinc-500"

export function formatMixUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

export function formatMixCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

/** Percentage width of a slice, clamped to a visible minimum so tiny slivers
 *  still render as a sliver rather than a hairline. Mirrors the bar-width
 *  math in the component. */
export function sliceWidthPct(usd: number, total: number): number {
  if (total <= 0) return 0.5
  return Math.max(0.5, (usd / total) * 100)
}

export function buildMarketplaceMix(data: MarketplaceMixData): MarketplaceMixResult {
  if (!data || Object.keys(data).length === 0) return { kind: "empty" }

  // Merge "on-chain" + "pinnacle" (some RPC versions emit one or the other);
  // the first label that wins is preserved via KNOWN_MARKETPLACES ordering.
  const merged: Record<string, MarketplaceMixEntry> = {}
  for (const [k, v] of Object.entries(data)) {
    const key = k.toLowerCase() === "pinnacle" ? "on-chain" : k.toLowerCase()
    const cur = merged[key] ?? { count: 0, usd: 0 }
    cur.count += Number(v?.count) || 0
    cur.usd += Number(v?.usd) || 0
    merged[key] = cur
  }

  const total = Object.values(merged).reduce((acc, v) => acc + v.usd, 0)
  if (total <= 0) return { kind: "no-volume" }

  const slices: MixSlice[] = []
  for (const k of KNOWN_MARKETPLACES) {
    const v = merged[k.key]
    if (!v) continue
    slices.push({
      key: k.key,
      label: k.label,
      count: v.count,
      usd: v.usd,
      color: k.color,
      className: k.className,
    })
    // Mark consumed so it doesn't double-fall into "other".
    delete merged[k.key]
  }
  // Anything left over goes into "other" (defensive — shouldn't normally occur).
  const otherUsd = Object.values(merged).reduce((acc, v) => acc + v.usd, 0)
  const otherCount = Object.values(merged).reduce((acc, v) => acc + v.count, 0)
  if (otherUsd > 0) {
    slices.push({
      key: "other",
      label: "Other",
      count: otherCount,
      usd: otherUsd,
      color: OTHER_SLICE_COLOR,
      className: OTHER_SLICE_CLASS,
    })
  }

  return { kind: "ok", slices, total }
}
