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
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import OfferSpreadBoardClient, { type Row } from "./OfferSpreadBoardClient"

// Match the API route's 5-minute edge cache.
// ⚠ THIS COMMENT USED TO END "edition_offers refreshes continuously" and that premise
// is what the page was built on. It is a claim about the offers-sweep cron, not about
// this cache, and on 2026-08-29 it was false for 30 hours. The 5-minute window still
// bounds how stale THIS RENDER is; how stale the ASKS are is a separate number the
// board now reports per row.
export const revalidate = 300

// Returns `ok:false` on a failed read so the page can say so. Before this the
// error path returned [] and the table rendered EMPTY at HTTP 200 — byte-identical
// to "no edition has a bid near its floor", i.e. a statement timeout rendered as a
// measurement. See lib/insights/board-status.ts.
async function fetchInitialRows(): Promise<{ rows: Row[]; ok: boolean }> {
  try {
    // The QUERY is shared with the API route via lib/insights/offer-spread-board.ts
    // so the two cannot drift; the limit and the $5 dust floor are the page's own
    // default view.
    const { data, error } = await withBoardBudget(fetchOfferSpreadBoard({ limit: 200, minAsk: 5 }), "offer-spread")
    if (error) {
      console.error("[insights/offer-spread] initial fetch", error.message)
      return { rows: [], ok: false }
    }
    return { rows: (data ?? []) as Row[], ok: true }
  } catch (e) {
    // A BUDGET OVERRUN lands here, not in the `error` branch above:
    // withBoardBudget REJECTS, which is how a merely-SLOW read reaches the
    // same honest-degraded outcome a failed one already had.
    console.error("[insights/offer-spread] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], ok: false }
  }
}

export default async function OfferSpreadPage() {
  const { rows, ok } = await fetchInitialRows()
  // ⚠ `initialFetchedAt` is NULL, not the render clock, when the read FAILED.
  // "Updated <now>" is a claim about the DATA's freshness built from OUR clock: on
  // a failed read it told the reader our numbers were current at the same moment
  // the board had none — the fabricated-freshness shape. FreshnessStamp renders
  // null as "—", whose documented meaning is exactly "no timestamp was supplied".
  // The DegradedDataNotice inside the board is NOT a substitute: a page with one
  // honest error branch is not an honest page.
  return (
    <OfferSpreadBoardClient
      initialRows={rows}
      initialDegraded={summarizeDegraded([boardStatus("Bid vs Floor", ok)])}
      initialFetchedAt={ok ? new Date().toISOString() : null}
      // ⚠ THE SERVER'S CLOCK, PASSED AS A PROP. The ask-age markers need a "now";
      // reading it in the client during render is React #418 (the hydration guard
      // catches it). Passing it serialised is hydration-SAFE — server and first
      // client render use the identical number — and it puts the honesty INTO THE
      // RAW HTML, which a post-mount-only clock cannot: without this, a reader with
      // JS disabled and every crawler still saw "Refreshes continuously" beside asks
      // that had not been re-checked in thirty hours.
      initialNowMs={Date.now()}
    />
  )
}
