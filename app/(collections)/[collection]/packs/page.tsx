"use client"

import { useParams } from "next/navigation"
import PackPageClient from "@/components/packs/PackPageClient"
import { getCollection } from "@/lib/collections"

// Packs view for NBA Top Shot and NFL All Day. The surrounding
// `[collection]/layout.tsx` gates access via `collectionHasPage(id, "packs")`
// — other collections never reach this component.
//
// All rendering and data-fetching lives in <PackPageClient/>, which reads
// from /api/packs (the unified pack_table_rows view) and renders the shared
// <PackTable/>. The "My Sealed Packs" wallet-query strip is owned by
// PackPageClient and sits above the main table on both collections.

const TS_TIERS = ["ultimate", "legendary", "rare", "fandom", "common"]
const ALLDAY_TIERS = ["ultimate", "legendary", "rare", "premium", "standard", "common"]

export default function PacksPage() {
  const params = useParams()
  const collection = (params?.collection as string) ?? "nba-top-shot"
  const collectionObj = getCollection(collection)
  const accent = collectionObj?.accent ?? "#E03A2F"

  if (collection === "nfl-all-day") {
    return (
      <PackPageClient
        collection="nfl-all-day"
        tiers={ALLDAY_TIERS}
        title="NFL All Day — Pack Distributions"
        accent={accent}
      />
    )
  }

  return (
    <PackPageClient
      collection="nba-top-shot"
      tiers={TS_TIERS}
      title="NBA Top Shot — Pack Distributions"
      accent={accent}
    />
  )
}
