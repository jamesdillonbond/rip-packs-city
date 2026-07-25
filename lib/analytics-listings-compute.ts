// Pure computation helpers extracted from components/analytics/ListingsDashboard.tsx.
// No React / JSX / browser-only globals — imported back into the component with
// zero behavior change so the branching logic is covered by the vitest ratchet.

export const COLLECTION_LABEL: Record<string, string> = {
  topshot: "Top Shot",
  allday: "All Day",
  golazos: "Golazos",
  pinnacle: "Pinnacle",
  ufc: "UFC",
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
