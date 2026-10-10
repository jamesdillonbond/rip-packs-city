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

export default async function PaniniPremiumsPage() {
  const { data, fetchedAt, ok } = await fetchBoardForPage<PaniniPremiumsPayload>("Panini premiums", EMPTY, (db) => fetchPaniniPremiums(db))
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Panini premiums", ok)])} />
      <PaniniPremiumsClient data={data} fetchedAt={ok ? fetchedAt : null} failed={!ok} />
    </>
  )
}
