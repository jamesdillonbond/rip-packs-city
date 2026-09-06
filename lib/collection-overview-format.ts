// Pure freshness/time helpers for the collection Overview page
// (app/(collections)/[collection]/overview/page.tsx — a ~670-line client neither
// coverage gate measures). freshnessFromAge is load-bearing: it decides the
// LIVE/DELAYED/OUTDATED pill, and the frozen-market ARCHIVED override that keeps
// a legitimately-stale market from reading as a broken pipeline to a visitor.
// Bodies are byte-identical to the originals; the page imports these.

export const EM_DASH = "—"

/** First non-empty candidate, else an em-dash. */
export function nameOrDash(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c
  }
  return EM_DASH
}

export function fmtPrice(n: number): string {
  return "$" + Math.round(n).toLocaleString()
}

/** "just now" / N min ago / Nh ago / Nd ago; em-dash for null. */
export function fmtAge(minutes: number | null): string {
  if (minutes == null) return EM_DASH
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${Math.round(minutes)} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Minutes since an ISO timestamp (never negative); null for empty/unparseable. */
export function minutesSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, (Date.now() - t) / 60000)
}

export type Freshness = { color: string; label: string; loading?: boolean }

/** Freshness pill state. Loading and frozen-market (ARCHIVED) short-circuit
 * before the age buckets: < 30m LIVE, < 60m DELAYED, else OUTDATED; unknown age
 * (null) → UNKNOWN. */
export function freshnessFromAge(
  minutes: number | null,
  loading: boolean,
  frozenMarket = false,
  cadence: "continuous" | "sale-driven" = "continuous",
): Freshness {
  if (loading) return { color: "var(--rpc-text-muted)", label: "Loading…", loading: true }
  // Sale-driven FMV (Candy MLB, 2026-09-06): snapshots are written when a sale
  // lands, not on a clock — measured gaps of 14 h between recomputes on a
  // 125-edition catalogue that trades a few times a day. Against the 30/60-min
  // buckets that reads as a broken pipeline for most of every day; it is not.
  // Report the cadence, keep the age visible, never colour it as a fault.
  if (cadence === "sale-driven" && !frozenMarket) {
    if (minutes == null) return { color: "var(--rpc-text-ghost)", label: "UNKNOWN" }
    return { color: "var(--rpc-text-muted)", label: "ON SALE" }
  }
  // Frozen-by-design markets (UFC Strike migrated to Aptos; the Flow market has
  // been frozen since 2026-05-13) have legitimately stale FMV — a red "OUTDATED"
  // pill reads as a broken pipeline to a public visitor. Show a neutral archival
  // pill instead; the MarketplaceStatusBanner already explains the migration.
  if (frozenMarket) return { color: "var(--rpc-text-muted)", label: "ARCHIVED" }
  if (minutes == null) return { color: "var(--rpc-text-ghost)", label: "UNKNOWN" }
  if (minutes < 30) return { color: "#34D399", label: "LIVE" }
  if (minutes < 60) return { color: "#F59E0B", label: "DELAYED" }
  return { color: "var(--rpc-red)", label: "OUTDATED" }
}
