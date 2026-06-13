// app/(collections)/[collection]/pack-sniper/page.tsx
//
// Per-collection Pack Sniper tab. SERVER component — fetches the collection's
// default deal view (honest deals only, high-variance hidden) via the shared
// getPackDeals() helper so the ranked table + drill-down links render in the
// raw server HTML, then hands them to PackSniperClient locked to this
// collection (compact heading, no standalone hero, no TS/AllDay toggle — the
// collection layout already supplies that context via its header + tabs).
//
// Only Top Shot + NFL All Day have pack data, so the "pack-sniper" page is in
// those two collections' `pages` arrays; any other slug notFound()s.

import { notFound } from "next/navigation"
import { getPackDeals, type PackDeal } from "@/lib/packs/pack-deals"
import { isSupportedPackCollection } from "@/lib/packs/live-pack-listings"
import { getCollection } from "@/lib/collections"
import PackSniperClient from "@/app/insights/pack-sniper/PackSniperClient"

// Live Dapper Studio fetch is memoized 2m; the API CDN-caches 5m. Match here.
export const revalidate = 300

export default async function CollectionPackSniperPage(
  props: { params: Promise<{ collection: string }> },
) {
  const { collection } = await props.params

  // Gate: must be a published collection that carries pack data and exposes the
  // pack-sniper page (Top Shot + NFL All Day today).
  if (
    !getCollection(collection) ||
    !isSupportedPackCollection(collection) ||
    !getCollection(collection)?.pages.includes("pack-sniper")
  ) {
    notFound()
  }

  let deals: PackDeal[] = []
  let fetchedAt = new Date().toISOString()
  try {
    const res = await getPackDeals(collection, { limit: 100, includeHighVariance: false })
    deals = res.deals
    fetchedAt = new Date().toISOString()
  } catch (e) {
    console.error(
      "[collection/pack-sniper] initial fetch",
      e instanceof Error ? e.message : e,
    )
  }

  return (
    <PackSniperClient
      lockedCollection={collection as "nba-top-shot" | "nfl-all-day"}
      initialDeals={deals}
      initialFetchedAt={fetchedAt}
    />
  )
}
