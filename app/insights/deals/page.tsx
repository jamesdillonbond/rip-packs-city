// app/insights/deals/page.tsx
//
// Public Below FMV board — SERVER component. Fetches the default board view
// (discount_pct >= 10, discount desc) directly from the public
// cross_collection_deals_board view via supabaseAdmin (exactly as
// /api/public/insights/deals does) and hands the rows to the client
// interactivity layer as `initialRows`. This puts the ranked table AND the
// per-row drill-down links (TS edition pages / Pinnacle pin pages) into the raw
// server HTML so the unique below-FMV content is crawlable. The client
// (DealsBoardClient) layers on collection/tier/confidence/sort/drill-down as
// progressive enhancement and only refetches when those change.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import DealsBoardClient, { type Row } from "./DealsBoardClient"
import { readBoardOrLive } from "@/lib/insights/board-cache"
import { degradedFromSource } from "@/lib/insights/board-status"
import { fetchDealsDefault } from "@/lib/insights/boards"

// Match the API route's 5-minute edge cache.
export const revalidate = 300

export default async function DealsPage() {
  // Serve the default board from the throttle-immune snapshot cache when it is
  // fresh; fall back to the live query, and to the last-good snapshot if the live
  // query fails under disk-IO saturation (nc1 PUBLIC-BOARD-CACHING).
  const { payload, source } = await readBoardOrLive("deals", () => fetchDealsDefault())
  const initialRows = (payload.rows as Row[]) ?? []
  // ⚠ UNCOALESCED ON PURPOSE, and it used to be `?? new Date().toISOString()`.
  // This board reads a materialized view since 2026-08-22, so the rows can be a full
  // refresh interval older than this render. `data_as_of` is when they were actually
  // computed; substituting now() when it is missing would restate the exact claim the
  // field exists to correct, and would do it precisely when the refresh is broken.
  // FreshnessStamp renders null as "—", which is the honest answer.
  const initialFetchedAt = (payload.data_as_of as string | null) ?? null
  return (
    <DealsBoardClient
      initialRows={initialRows}
      initialFetchedAt={initialFetchedAt}
      // ⚠ THE SERVER'S CLOCK, PASSED AS A PROP, AND BOTH HALVES ARE DELIBERATE.
      // The ask-age markers need a "now"; reading it in the client during render is
      // React #418 (the hydration guard catches it). Passing it as a prop is
      // hydration-SAFE — the value is serialised into the payload, so the server
      // render and the first client render use the identical number — and it also
      // puts the honesty INTO THE RAW HTML, which a post-mount-only clock cannot:
      // without this, a reader with JS disabled and every crawler still saw
      // "Asks refresh continuously" while the asks were a day old.
      // ⚠ `revalidate = 300` above means this is at most 5 minutes stale. The
      // markers are hour-granular, so that is immaterial; the client refreshes it
      // on mount anyway.
      initialNowMs={Date.now()}
      initialDegraded={degradedFromSource(source, "Below FMV board")}
    />
  )
}
