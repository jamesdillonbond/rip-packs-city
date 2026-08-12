// app/insights/market-pulse/page.tsx — SERVER component. Fetches the windowed
// pulse and hands it to the client. Metadata + JSON-LD in layout.tsx.
import MarketPulseClient from "./MarketPulseClient"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { supabaseAdmin } from "@/lib/supabase"
import { fetchMarketPulse, type MarketPulseRow } from "@/lib/market-pulse-board"

export const revalidate = 300

export default async function MarketPulsePage() {
  let rows: MarketPulseRow[] = []
  // `ok` distinguishes "the market was quiet" from "we failed to ask". Without it
  // the catch below left rows at [] and the board rendered EMPTY at HTTP 200,
  // byte-identical to a genuinely quiet window.
  let ok = true
  const fetchedAt = new Date().toISOString()
  try {
    rows = await fetchMarketPulse(supabaseAdmin)
  } catch (e) {
    console.error("[insights/market-pulse] initial fetch", e instanceof Error ? e.message : e)
    ok = false
  }
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Market pulse", ok)])} />
      <MarketPulseClient initialRows={rows} fetchedAt={fetchedAt} />
    </>
  )
}
