// app/insights/pack-sniper/page.tsx
//
// Public Pack Sniper deal board — SERVER component. Fetches the default view
// (Top Shot, MATCHING the client's default — high-variance packs INCLUDED and
// flagged, not hidden; see fetchInitial) via the
// shared getPackDeals() helper and hands them to the client interactivity layer
// as initialDeals. This puts the ranked table AND the per-row drill-down links
// (/<collection>/pack/dist/<distId>) into the raw server HTML so the unique
// content is crawlable. The client (PackSniperClient) layers on the collection
// toggle, the show/hide-high-variance toggle, and refetch.
//
// RANK, DON'T PRICE — see lib/packs/pack-deals.ts for the honesty rationale.
// Metadata + JSON-LD live in layout.tsx.

import { getPackDeals, type PackDeal } from "@/lib/packs/pack-deals"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import PackSniperClient from "./PackSniperClient"

// Live Dapper Studio fetch is memoized 2m; the API CDN-caches 5m. Match here.
export const revalidate = 300

async function fetchInitial(): Promise<{ deals: PackDeal[]; fetchedAt: string; ok: boolean }> {
  try {
    // Default crawlable view: Top Shot, MATCHING THE CLIENT DEFAULT.
    //
    // ⚠ This was `includeHighVariance: false` and it rendered an EMPTY TABLE into
    // the server HTML — the exact opposite of the header's stated purpose above.
    // Measured live 2026-08-23 against the served response:
    //
    //   TS include_high_variance=false → matched 84, highVariance 84, returned 0
    //   TS include_high_variance=true  → matched 84, highVariance 84, returned 84
    //   AD include_high_variance=false → 30   (no-change control: the filter, not
    //   AD include_high_variance=true  → 95    a broken API)
    //
    // EVERY matched Top Shot pack is currently high-variance, so hiding them hid
    // the whole board. The 2026-07-09 client reconciliation already defaulted the
    // other way for exactly this reason — "defaulting to hide would render an
    // empty board whenever every listed pack is high-variance, which is common" —
    // and the server half was never updated.
    //
    // ⚠ THE CLIENT FIX MASKED THIS. Humans see 84 rows because PackSniperClient
    // refetches with `true`; only a crawler, or a measurement of the SERVED HTML,
    // could see the emptiness. Verify by grepping the served body for
    // `/pack/dist/`, NEVER by loading the page in a browser.
    //
    // High-variance rows are flagged in the row rendering, so this does not
    // present lottery packs as honest deals.
    const res = await withBoardBudget(
      getPackDeals("nba-top-shot", { limit: 200, includeHighVariance: true }),
      "pack-sniper",
    )
    return { deals: res.deals, fetchedAt: new Date().toISOString(), ok: true }
  } catch (e) {
    console.error("[insights/pack-sniper] initial fetch", e instanceof Error ? e.message : e)
    return { deals: [], fetchedAt: new Date().toISOString(), ok: false }
  }
}

export default async function PackSniperPage() {
  const { deals, fetchedAt, ok } = await fetchInitial()
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Pack sniper", ok)])} />
      <PackSniperClient initialDeals={deals} initialFetchedAt={fetchedAt} />
    </>
  )
}
