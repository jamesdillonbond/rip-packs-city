// app/insights/market-cap/page.tsx
//
// Public Market Cap board — SERVER component. Fetches the per-collection totals and
// the default drill-down (Top Shot players) from get_market_cap_board() server-side,
// so both land in the raw server HTML and are crawlable. The client adds the
// collection / grain switcher, which reads /api/public/insights/market-cap.
// Metadata + JSON-LD live in layout.tsx.

import MarketCapBoardClient from "./MarketCapBoardClient"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchMarketCapBoard, type MarketCapBoard } from "@/lib/insights/market-cap-board"

// Computed per call from FMV + supply tables; 15-min ISR matches the route's edge cache.
export const revalidate = 900

const DEFAULT_DRILL_COLLECTION = "nba_top_shot"
const DEFAULT_DRILL_GROUP = "player" as const

export default async function MarketCapPage() {
  const [collections, drill] = await Promise.all([
    fetchBoardForPage<MarketCapBoard>(
      "Market cap",
      { group: "collection", collection: null, rows: [] },
      (db) => fetchMarketCapBoard(db, "collection", null, 50),
    ),
    fetchBoardForPage<MarketCapBoard>(
      "Market cap drill-down",
      { group: DEFAULT_DRILL_GROUP, collection: DEFAULT_DRILL_COLLECTION, rows: [] },
      (db) => fetchMarketCapBoard(db, DEFAULT_DRILL_GROUP, DEFAULT_DRILL_COLLECTION, 50),
    ),
  ])
  return (
    <>
      <DegradedDataNotice
        summary={summarizeDegraded([
          boardStatus("Collection market caps", collections.ok),
          boardStatus("Market cap drill-down", drill.ok),
        ])}
      />
      {/* Each panel also carries its own failed flag: the banner is not a substitute
          for a panel that would otherwise state "no rows" as a fact. */}
      <MarketCapBoardClient
        initialCollections={collections.data}
        initialCollectionsFailed={!collections.ok}
        initialDrill={drill.data}
        initialDrillFailed={!drill.ok}
        initialFetchedAt={collections.ok ? collections.fetchedAt : null}
      />
    </>
  )
}
