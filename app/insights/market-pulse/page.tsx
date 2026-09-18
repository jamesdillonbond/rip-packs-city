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
      {/* ⚠ The stamp is WHEN WE ASKED, not the age of the data (board-page-fetch's
          own header). Forwarding it on a failed read printed "Updated <now> ET"
          beside a board that never loaded — deep-audit 2026-09-18 R95. */}
      <MarketPulseClient initialRows={rows} fetchedAt={ok ? fetchedAt : null} />
    </>
  )
}
