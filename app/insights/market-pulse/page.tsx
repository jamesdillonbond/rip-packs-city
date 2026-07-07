// app/insights/market-pulse/page.tsx — SERVER component. Fetches the windowed
// pulse and hands it to the client. Metadata + JSON-LD in layout.tsx.
import MarketPulseClient from "./MarketPulseClient"
import { supabaseAdmin } from "@/lib/supabase"
import { fetchMarketPulse, type MarketPulseRow } from "@/lib/market-pulse-board"

export const revalidate = 300

export default async function MarketPulsePage() {
  let rows: MarketPulseRow[] = []
  const fetchedAt = new Date().toISOString()
  try {
    rows = await fetchMarketPulse(supabaseAdmin)
  } catch (e) {
    console.error("[insights/market-pulse] initial fetch", e instanceof Error ? e.message : e)
  }
  return <MarketPulseClient initialRows={rows} fetchedAt={fetchedAt} />
}
