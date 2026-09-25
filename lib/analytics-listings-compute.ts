// Pure computation helpers extracted from components/analytics/ListingsDashboard.tsx.
// No React / JSX / browser-only globals — imported back into the component with
// zero behavior change so the branching logic is covered by the vitest ratchet.

import { usdSignFirst } from "@/lib/usd-format"

export const COLLECTION_LABEL: Record<string, string> = {
  topshot: "Top Shot",
  allday: "All Day",
  golazos: "Golazos",
  pinnacle: "Pinnacle",
  ufc: "UFC",
  // ⚠ 2026-09-20 — REQUIRED BY THE SAME CHANGE THAT MADE THE ROW APPEAR, not a
  // speculative addition. `analytics_listings_summary` gained a Candy arm today
  // (migration 20260920153900) because Candy's ~1,900 live asks live in
  // `candy_listings`, never in `cached_listings`, so the RPC reported an empty
  // order book for it. The key is the LONG slug because that RPC family's
  // `CASE … ELSE c.slug` emits `candy_mlb` — the same key
  // lib/analytics-sets-dashboard-compute.ts has labelled since 2026-07-31.
  // resolveCollectionLabel() falls back to the RAW SLUG, so without this line
  // /analytics/listings renders a row literally labelled "candy_mlb".
  candy_mlb: "Candy MLB",
}

export interface ListingsSortOption {
  value: string
  label: string
  caption: string
}

export const SORT_OPTIONS: ListingsSortOption[] = [
  { value: "apr_desc", label: "Highest APR", caption: "Best yield → highest APR offers" },
  { value: "apr_asc", label: "Lowest APR", caption: "Cheapest borrows → lowest APR offers" },
  { value: "principal_desc", label: "Largest principal", caption: "Most liquidity → largest principal" },
  { value: "principal_asc", label: "Smallest principal", caption: "Smallest borrow first" },
  { value: "newest", label: "Newest", caption: "Just listed → newest first" },
]

export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

export function formatPrice(n: number | null | undefined): string {
  const neg = usdSignFirst(n, formatPrice); if (neg !== null) return neg
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

export function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `${n.toFixed(0)}%`
}

// `now` is injectable so tests are deterministic; the component omits it,
// keeping the runtime call identical to `Date.now()`.
export function relativeTime(
  iso: string | null | undefined,
  now: number = Date.now()
): string {
  if (!iso) return "—"
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return "—"
  const diff = now - t
  if (diff < 60_000) return "just now"
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`
  if (diff < 30 * 24 * 60 * 60_000) return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`
  return new Date(iso).toLocaleDateString()
}

export function truncateAddr(addr: string | null | undefined): string {
  if (!addr) return "—"
  const a = String(addr).toLowerCase()
  if (!a.startsWith("0x") || a.length <= 10) return a
  return a.slice(0, 6) + "…" + a.slice(-4)
}

export function isLinkableAddr(a: string | null | undefined): a is string {
  return !!a && /^0x[0-9a-f]{16}$/i.test(a)
}

// Resolve the display label for a collection short-code, falling back to the
// raw value when it isn't in the known map.
export function resolveCollectionLabel(
  collection: string | null | undefined
): string | null | undefined {
  return COLLECTION_LABEL[(collection ?? "").toLowerCase()] ?? collection
}

// The active sort option, defaulting to the first when the value is unknown.
export function resolveSortOption(sort: string): ListingsSortOption {
  return SORT_OPTIONS.find((o) => o.value === sort) ?? SORT_OPTIONS[0]
}

// A per-collection listings row is "sparse" when its sampled count is small.
export function isSparseListingCount(count: number | null | undefined): boolean {
  return count != null && count < 30
}

// Audit 2026-05-20: analytics_listings_summary RPC can return
// marketplace_listings as {} (not []) when empty; a plain ?? [] only catches
// null/undefined, so a later .map would throw. Coerce to a real array.
export function normalizeMarketplaceListings<T>(raw: T[] | null | undefined): T[] {
  return Array.isArray(raw) ? raw : []
}

/**
 * `data_caveats` → a flat list of caveat sentences to render.
 *
 * 🚨 WHY THIS EXISTS (found 2026-09-20 while adding the Candy arm, and it is a
 * DEAD DISCLOSURE, not a formatting nit). `analytics_listings_summary` has
 * always emitted `data_caveats` as a jsonb OBJECT —
 * `{ topshot_sample: "…", cached_sniper_bias: "…", dead_listing_filter: "…" }`
 * — while ListingsSummaryResponse typed it `string[]` and the dashboard gated
 * the whole "About this data" section on `data_caveats.length > 0`. On an
 * object that reads `undefined`, so the guard has ALWAYS been falsy and the
 * section has NEVER rendered. `tsc` could not see it: the declared type was
 * simply wrong about the runtime shape, so the lie type-checked.
 *
 * ⚠ That matters more now than it did yesterday. The same RPC now returns a
 * Candy MLB row whose provenance differs from every other row in the table —
 * a FULL active-ask snapshot from Magic Eden on Solana, not a Sniper-scan
 * sample of a Flow orderbook. The sentence saying so is one of these caveats.
 * A caveat that cannot render is not a disclosure.
 *
 * Accepts both shapes because only the object shape is observed today and a
 * future writer may legitimately emit a list; anything else yields `[]` so the
 * section simply does not render rather than throwing.
 */
export function normalizeDataCaveats(
  raw: Record<string, string> | string[] | null | undefined
): string[] {
  if (Array.isArray(raw)) return raw.filter((c): c is string => typeof c === "string" && c.length > 0)
  if (raw && typeof raw === "object") {
    return Object.values(raw).filter((c): c is string => typeof c === "string" && c.length > 0)
  }
  return []
}
