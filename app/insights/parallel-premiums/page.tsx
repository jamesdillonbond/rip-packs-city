// app/insights/parallel-premiums/page.tsx
//
// Public Parallel Premiums — SERVER component. Fetches the default view (both
// sides HIGH/MED FMV, premium desc) directly from v_topshot_parallel_premiums
// and hands them to the client as initialRows so the ranked board + drill-down
// links are in the raw server HTML (the SEO thesis). The client layers the
// parallel / confidence / sort filters as progressive enhancement.
//
// Metadata + JSON-LD live in layout.tsx.

import ParallelPremiumsBoardClient from "./ParallelPremiumsBoardClient"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchParallelPremiums, type ParallelRow } from "@/lib/parallel-premiums-board"

// The backing view reads FMV live; 15-min ISR matches the route's edge cache.
export const revalidate = 900


export default async function ParallelPremiumsPage() {
  const { data: rows, fetchedAt, ok } = await fetchBoardForPage<ParallelRow[]>(
    "Parallel premiums",
    [],
    (db) => fetchParallelPremiums(db, {
      parallelName: null,
      minPremium: 1.5,
      highConfOnly: true,
      sort: "premium",
      limit: 100,
    }),
  )
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Parallel premiums", ok)])} />
      <ParallelPremiumsBoardClient initialRows={rows} initialFetchedAt={fetchedAt} />
    </>
  )
}
