// app/api/candy-properties/route.ts
//
// The league / brand scope index for the Candy tabs (2026-11-26): every Candy brand that has a collection
// (get_candy_property_board, migration 20261126201654) — the chips of the "League or brand" bar. GET-only,
// no session, catalogue data only — public like the Candy tabs it serves. Same shape as
// /api/panini-properties so one client (components/collection/PaniniScopeBar.tsx) reads both. A failed read
// is a 5xx through apiErrorResponse, never an empty index (an empty index would silently remove the scope
// control and un-filter a scoped tab).

import { NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { readCandyPropertyBoard } from "@/lib/candy/properties"

export const dynamic = "force-dynamic"

const FAIL = "Leagues and brands are unavailable right now."
const TAG = "api/candy-properties"

export async function GET() {
  try {
    const res = await readCandyPropertyBoard()
    if (!res.ok) return apiErrorResponse(new Error("candy property board read failed"), TAG, FAIL)
    const properties = res.board.properties
      // Only brands with a live ask: the bar sits on the Market tab, and a chip that can only show an empty
      // market is noise. (A deep link to an unlisted brand falls back to "All" — the client drops unknown slugs.)
      .filter((p) => p.listed_editions > 0)
      .map((p) => ({ slug: p.slug, name: p.name, heading: p.heading, sort_order: p.sort_order, listed: p.listed_editions }))
    // setProperty is Panini's product-id map; Candy filters on the server, so it is empty here.
    return NextResponse.json({ properties, setProperty: {} }, { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600" } })
  } catch (e) {
    return apiErrorResponse(e, TAG, FAIL)
  }
}
