// app/insights/pack-drops/page.tsx
//
// Public Pack Drops — SERVER component. Discovers + scores the live Vaultopolis
// re-pack drops server-side (the exact payload the
// /api/public/insights/pack-drops route serves) and hands them to the client
// presentation layer as `initialDrops`. This puts the scored RPC-vs-operator
// tables + per-drop drill-down links into the raw server HTML so the unique
// content (RPC pool / pack EV / matched editions) is crawlable — the SEO thesis.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import PackDropsBoardClient from "./PackDropsBoardClient"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchScoredDrops, type ScoredDrop } from "@/lib/pack-drops-board"

// Vaultopolis composition/odds are fixed at publication; 15-min ISR matches the
// route's edge cache.
export const revalidate = 900


export default async function PackDropsPage() {
  const { data: drops, fetchedAt, ok } = await fetchBoardForPage<ScoredDrop[]>(
    "Pack drops",
    [],
    (db) => fetchScoredDrops(db),
  )
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Pack drops", ok)])} />
      {/*
        ⚠ `initialFailed` is the FIFTH honesty layer, and the banner above is not a
        substitute for it. On a failed read `fetchBoardForPage` returns the `[]`
        fallback, which arrives here carrying NO PROVENANCE — so without this prop
        the board below states "No live re-pack drops to score right now" as a fact
        about the market, directly under a notice saying the data is degraded.
        This client does NOT refetch on mount ("only refetch on explicit refresh"),
        so that sentence stands until someone presses Refresh. And this page's whole
        purpose is putting the scored drops into the raw server HTML for crawlers,
        which is exactly the copy a crawler would take away.
      */}
      <PackDropsBoardClient initialDrops={drops} initialFetchedAt={fetchedAt} initialFailed={!ok} />
    </>
  )
}
