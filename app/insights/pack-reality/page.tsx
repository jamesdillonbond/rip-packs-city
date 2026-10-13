// app/insights/pack-reality/page.tsx — SERVER shell (review E2, 2026-10-13).
//
// The board body lives in PackRealityClient.tsx (the component gate's
// `app/**/*Client.tsx` glob measures it). This page makes ONE bounded read of
// the same body the public route serves and hands it to the client as the
// first frame, so a crawler and a first paint carry the rips, the median and
// the ranker instead of em-dashes and "Loading…".
//
// ⚠ A PARTIAL read seeds NULL, not a degraded payload. The route publishes a
// partial body with `meta.errors` named, and the client renders that honestly
// — but this segment is ISR (5 min, matching the route's s-maxage), and an
// ISR'd "temporarily unavailable" is a failure cached as a claim (#33). Null is
// the absence: the client then does exactly what it did before the seed
// existed — its own read, its own three-way honesty.
//
// Bounded through fetchBoardForPage: the read is prerendered, and Next gives a
// page 60 s to export before it kills the build (board-page-fetch.ts).

import PackRealityClient, { type ApiResponse } from "./PackRealityClient"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { readTopshotPackReality, type TopshotPackRealityBody } from "@/lib/insights/topshot-pack-reality"

export const revalidate = 300

export default async function PackRealityPage() {
  const { data, ok } = await fetchBoardForPage<TopshotPackRealityBody | null>(
    "Top Shot pack reality",
    null,
    async (db) => {
      const read = await readTopshotPackReality(db, 10)
      // Total outage AND partial both seed null — see the header.
      return read.totalOutage || read.errors.length > 0 ? null : read.body
    },
  )
  // The lib's body IS the route's wire shape, which is what the client's
  // `ApiResponse` describes from the receiving side (its `stats` names the
  // columns; the lib carries them as an open record). One cast, here, where the
  // two meet — not a second copy of the row type.
  return <PackRealityClient initialData={(ok ? data : null) as ApiResponse | null} />
}
