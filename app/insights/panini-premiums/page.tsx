// app/insights/panini-premiums/page.tsx
//
// Panini Premiums — SERVER component (2026-10-10). Reads both boards server-side
// (lib/insights/panini-premiums.ts; the views are service-role only) and hands them to the client,
// so the ranked rows and their edition links are in the raw HTML. The client layers the tab and
// sport filters in memory — there is no public JSON route to refetch from.
//
// ⚠ `initialFailed` is the fifth honesty layer: fetchBoardForPage returns the fallback on a failed
// read, and an empty fallback carries no provenance. The client renders "couldn't load" from it,
// never "no premiums".

import PaniniPremiumsClient from "./PaniniPremiumsClient"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchPaniniPremiums, type PaniniPremiumsPayload } from "@/lib/insights/panini-premiums"

// FMV moves on the 30-min bridge and sales on Panini's ~2-hourly walk; hourly ISR is ample.
export const revalidate = 3600

const EMPTY: PaniniPremiumsPayload = { parallels: [], parallelsCapped: false, serials: [], serialsCapped: false }

// ⚠ This page's read gets 25 s, not the shared 8 s BOARD_LIVE_TIMEOUT_MS. Measured 2026-11-15:
// `panini_serial_premiums` re-aggregates 90 days of panini_sales on every call (~30.5k heap
// blocks; pgss mean 4.5 s, max 18.7 s, ~11.9k disk reads per call), and EVERY hourly regeneration
// logged in the prior 24 h died at 8 s ("read exceeded 8000ms"), so the page served its cached
// "couldn't load" around the clock (deep audit 2026-11-15, D2). Hourly ISR regenerates in the
// BACKGROUND, so a slow read delays nobody; 25 s stays under service_role's 30 s statement_timeout
// and well under Next's 60 s prerender limit (the build-integrity reason the 8 s bound exists).
// The structural fix is a precomputed matview for the serial board; when it lands, drop this.
const PANINI_PREMIUMS_READ_BUDGET_MS = 25_000

export default async function PaniniPremiumsPage() {
  const { data, fetchedAt, ok } = await fetchBoardForPage<PaniniPremiumsPayload>(
    "Panini premiums",
    EMPTY,
    (db) => fetchPaniniPremiums(db),
    PANINI_PREMIUMS_READ_BUDGET_MS,
  )
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Panini premiums", ok)])} />
      <PaniniPremiumsClient data={data} fetchedAt={ok ? fetchedAt : null} failed={!ok} />
    </>
  )
}
