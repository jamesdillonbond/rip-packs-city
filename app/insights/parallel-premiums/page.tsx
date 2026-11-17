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

// ⚠ This page's read gets 25 s, not the shared 8 s BOARD_LIVE_TIMEOUT_MS — the same call
// /insights/panini-premiums made on 2026-11-15. Measured 2026-11-16: the default read of
// v_topshot_parallel_premiums runs a newest-FMV lateral per parallel edition (5,103 parallels,
// ~76k buffers, 2.8 s cold with 2.6 s of it disk reads); pgss over 5,103 calls: mean 3.3 s,
// sd 6.0 s, max 29.9 s. So a cold or contended regeneration overruns 8 s, and a failed read is
// cached by ISR for the whole 15-min window ("read exceeded 8000ms", Vercel runtime errors,
// recurring since 08-17). ISR regenerates in the BACKGROUND, so a slower read delays nobody;
// 25 s stays under service_role's 30 s statement_timeout and Next's 60 s prerender limit.
const PARALLEL_PREMIUMS_READ_BUDGET_MS = 25_000

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
    PARALLEL_PREMIUMS_READ_BUDGET_MS,
  )
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Parallel premiums", ok)])} />
      {/*
        ⚠ `initialFailed` is the FIFTH honesty layer, and the banner above is NOT a
        substitute for it — the 2026-08-24 sweep that fixed five boards records that
        all five already had one. `fetchBoardForPage` returns `[]` on a failed read,
        and that arrives below carrying NO PROVENANCE.
        ⚠ This client already renders the right degraded sentence for its OWN
        refetch; it simply started that state at `false` no matter what the server read
        did. Its effect also returns early on the first render, so there is no mount
        refetch to correct it.
      */}
      <ParallelPremiumsBoardClient initialRows={rows} initialFetchedAt={ok ? fetchedAt : null} initialFailed={!ok} />
    </>
  )
}
