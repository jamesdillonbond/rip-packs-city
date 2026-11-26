// lib/analytics/ufc-aptos-book.ts
//
// UFC Strike's order book is on Aptos (Rarible) since its Flow market closed 2026-05-13.
// analytics_listings_summary reads Flow listings only, so /ufc/analytics' Order Book Depth
// said "No live listings." beside ~465 live Aptos asks (2026-11-26). This builds the UFC
// entry from the same source as /ufc/sniper (computeUfcAptosSniperFeed: live singles
// re-checked in the last 3 days, priced in USD at the day's APT rate).

import type { ListingsMarketplaceCollectionEntry } from "@/lib/analytics-types"

export type UfcAptosBookEntry = ListingsMarketplaceCollectionEntry & { p90_ask_usd: number | null; chain: "aptos" }

const round2 = (n: number) => Math.round(n * 100) / 100

/** Nearest-rank percentile of an ascending list (p in 0..1). */
function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

export function summarizeUfcAptosBook(asksUsd: number[]): UfcAptosBookEntry {
  const a = asksUsd.filter((x) => Number.isFinite(x) && x > 0).sort((x, y) => x - y)
  if (a.length === 0) {
    return { collection: "ufc", count: 0, min_ask_usd: null, max_ask_usd: null, avg_ask_usd: null, median_ask_usd: null, p90_ask_usd: null, chain: "aptos" }
  }
  const mid = Math.floor(a.length / 2)
  const median = a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
  return {
    collection: "ufc",
    count: a.length,
    min_ask_usd: round2(a[0]),
    max_ask_usd: round2(a[a.length - 1]),
    avg_ask_usd: round2(a.reduce((s, x) => s + x, 0) / a.length),
    median_ask_usd: round2(median),
    p90_ask_usd: round2(pct(a, 0.9)),
    chain: "aptos",
  }
}

/** Replace (or add) the UFC row of a marketplace_listings list. */
export function withUfcAptosBook<T extends { collection: string }>(rows: unknown, entry: T): T[] {
  const list = Array.isArray(rows) ? (rows as T[]) : []
  return [...list.filter((r) => (r.collection || "").toLowerCase() !== "ufc"), entry]
}
