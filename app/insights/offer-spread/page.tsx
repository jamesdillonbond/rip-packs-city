// app/insights/offer-spread/page.tsx
//
// Public Bid vs Floor board — SERVER component. Fetches the default board view
// (low_ask >= 5, tightest par first) directly from the public
// topshot_offer_ask_spread view via supabaseAdmin (exactly as
// /api/public/insights/offer-spread does) and hands the rows to the client
// interactivity layer as `initialRows`. This puts the ranked table AND the
// per-row /nba-top-shot/edition/<external_id> drill-down links into the raw
// server HTML so the unique bid-vs-floor content is crawlable. The client
// (OfferSpreadBoardClient) layers on tier/bid-meets-floor/sort/drill-down as
// progressive enhancement and only refetches when those change.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { fetchOfferSpreadBoard } from "@/lib/insights/offer-spread-board"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import OfferSpreadBoardClient, { type Row } from "./OfferSpreadBoardClient"

// Match the API route's 5-minute edge cache; edition_offers refreshes continuously.
export const revalidate = 300

// Returns `ok:false` on a failed read so the page can say so. Before this the
// error path returned [] and the table rendered EMPTY at HTTP 200 — byte-identical
// to "no edition has a bid near its floor", i.e. a statement timeout rendered as a
// measurement. See lib/insights/board-status.ts.
async function fetchInitialRows(): Promise<{ rows: Row[]; ok: boolean }> {
  // The QUERY is shared with the API route via lib/insights/offer-spread-board.ts
  // so the two cannot drift; the limit and the $5 dust floor are the page's own
  // default view.
  const { data, error } = await fetchOfferSpreadBoard({ limit: 200, minAsk: 5 })
  if (error) {
    console.error("[insights/offer-spread] initial fetch", error.message)
    return { rows: [], ok: false }
  }
  return { rows: (data ?? []) as Row[], ok: true }
}

export default async function OfferSpreadPage() {
  const { rows, ok } = await fetchInitialRows()
  return (
    <OfferSpreadBoardClient
      initialRows={rows}
      initialDegraded={summarizeDegraded([boardStatus("Bid vs Floor", ok)])}
      initialFetchedAt={new Date().toISOString()}
    />
  )
}
