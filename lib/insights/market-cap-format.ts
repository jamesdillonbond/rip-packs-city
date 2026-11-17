// lib/insights/market-cap-format.ts
//
// Display formatters for the Market Cap board. Kept apart from the fetcher in
// market-cap-board.ts so they stay pure (no DB client in the module). A null /
// non-finite input renders "—" — an unknown figure is never printed as $0.

import { usdSignFirst } from "@/lib/usd-format"
import { getCollectionByDbSlug } from "@/lib/collection-slug"

export function fmtUsdCompact(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—"
  const neg = usdSignFirst(n, fmtUsdCompact)
  if (neg != null) return neg
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e4) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

export function fmtCount(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return Math.round(n).toLocaleString("en-US")
}

/**
 * A collection's display name from its DB slug (`nba_top_shot` → "NBA Top Shot"),
 * and the 7-day change ratio. They live here, not in market-cap-board.ts,
 * because that module holds the RPC reads: a server page importing a pure helper
 * from it reaches a Supabase read down an unbounded path, and
 * `check-unbounded-server-reads` is right to say so (2026-10-03: MarketCapTile on
 * the edition / player / team / set pages reddened `main` that way).
 */
export function collectionDisplayName(dbSlug: string): string {
  return getCollectionByDbSlug(dbSlug)?.displayName ?? dbSlug
}

/** `now / ago - 1`; null when either side is unknown or the base is not positive. */
export function sevenDayChange(now: number | null, ago: number | null): number | null {
  if (now == null || ago == null || !Number.isFinite(now) || !Number.isFinite(ago) || ago <= 0) return null
  return now / ago - 1
}

/**
 * Why an entity's market cap is Unknown, for the tile's sub-label. Each clause
 * names a cause the row PROVES, in this order:
 *   · a minted-supply bound exists  → the bound (the caller formats it)
 *   · nothing in it has a price     → say so ("no price yet")
 *   · burns unpublished somewhere   → "no burn count published"
 *   · otherwise                     → a cause we cannot name, stated as such
 *
 * ⛔ 2026-10-14: this used to fall through to "no burn count published" for every
 * Unknown without a bound. On a 1/1 Top Shot edition with no sale (253:9148) that
 * printed "no burn count published" directly beside a rendered "Burned 0" — the
 * burn count WAS published; the edition simply has no price.
 */
export function unknownCapReason(
  row: { editions: number; editions_priced: number; editions_supply_known: number },
  isEdition: boolean,
): string {
  if (row.editions_priced === 0) return isEdition ? "no price for this edition yet" : "none of its editions has a price yet"
  if (row.editions_supply_known < row.editions) return "no burn count published"
  return "price or supply incomplete"
}
