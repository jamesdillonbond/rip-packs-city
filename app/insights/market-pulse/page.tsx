// app/insights/market-pulse/page.tsx — SERVER component. Fetches the windowed
// pulse and hands it to the client. Metadata + JSON-LD in layout.tsx.
import MarketPulseClient from "./MarketPulseClient"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchMarketPulse, type MarketPulseRow } from "@/lib/market-pulse-board"

export const revalidate = 300

export default async function MarketPulsePage() {
  // `ok` distinguishes "the market was quiet" from "we failed to ask". Without it
  // a failed read leaves rows at [] and the board renders EMPTY at HTTP 200,
  // byte-identical to a genuinely quiet window.
  const { data: rows, fetchedAt, ok } = await fetchBoardForPage<MarketPulseRow[]>(
    "Market pulse",
    [],
    (db) => fetchMarketPulse(db),
  )
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Market pulse", ok)])} />
      <MarketPulseClient initialRows={rows} fetchedAt={fetchedAt} />
    </>
  )
}
