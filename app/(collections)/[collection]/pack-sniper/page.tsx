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
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
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

  // ⚠ HONESTY CANON — this page is the collection-scoped twin of
  // /insights/pack-sniper, renders the SAME PackSniperClient from the SAME
  // getPackDeals() helper, and was missing BOTH of the things its sibling does.
  //
  // 1. NO PROVENANCE. The catch left `deals = []` and passed it on with a
  //    `fetchedAt` minted from the clock BEFORE the fetch, so the client could
  //    not tell a 503 from a genuinely quiet market and rendered "no +EV packs"
  //    — the literal opening example in CLAUDE.md's honesty canon — under
  //    `revalidate = 300`, i.e. cached for five minutes.
  // 2. NO BUDGET. The read was unbounded. Measured across the whole `app/`
  //    tree, 24 of 25 server pages that do a board read bound it; this was the
  //    one that did not, because `insights-server-pages-bound-their-reads`
  //    walks `app/insights` ONLY and this page lives under `app/(collections)`.
  //    Same class as the 2026-08-15 incident where an unbounded board read
  //    ERRORed a whole production deploy — and that guard's root, not its
  //    logic, is what had been fixing its blast radius. The guard now walks the
  //    whole tree, so this page is inside it.
  let deals: PackDeal[] = []
  let ok = true
  try {
    const res = await withBoardBudget(
      getPackDeals(collection, { limit: 200, includeHighVariance: true }),
      "pack-sniper",
    )
    deals = res.deals
  } catch (e) {
    console.error(
      "[collection/pack-sniper] initial fetch",
      e instanceof Error ? e.message : e,
    )
    ok = false
  }
  // Stamped AFTER the read, and only meaningful when the read succeeded — a
  // "fetched at" minted before the work says "now" even when nothing was read.
  const fetchedAt = new Date().toISOString()

  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Pack sniper", ok)])} />
      <PackSniperClient
        lockedCollection={collection as "nba-top-shot" | "nfl-all-day"}
        initialDeals={deals}
        initialFetchedAt={fetchedAt}
        initialFailed={!ok}
      />
    </>
  )
}
