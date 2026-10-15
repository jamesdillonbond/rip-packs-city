// app/api/market/teams/route.ts
//
// Every team a collection's editions carry, for the Market page's Team
// dropdown. The dropdown used to be built from the 50 listings on screen, so a
// team with no listing on the current page (Portland Fire, 2026-10-14) could not
// be picked at all. get_market_team_options reads editions.team_name — the
// column the market RPCs filter on — so every option offered is matchable.
//
// An unknown collectionId is refused (400), never defaulted to another
// collection's teams. A failed read answers through apiErrorResponse; the client
// then falls back to the teams on the current page.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { getCollectionByUuid } from "@/lib/collections"

export async function GET(req: NextRequest) {
  const collectionId = req.nextUrl.searchParams.get("collectionId") ?? ""
  if (!getCollectionByUuid(collectionId)) {
    return NextResponse.json({ error: "unknown collectionId" }, { status: 400 })
  }

  const { data, error } = await boundedRead(
    (supabaseAdmin as any).rpc("get_market_team_options", { p_collection_id: collectionId }),
    "api/market/teams/get_market_team_options",
  )
  if (error) {
    console.error("[api/market/teams]", error.message)
    return apiErrorResponse(error, "api/market/teams")
  }

  const teams = ((data ?? []) as Array<{ team_name: string | null }>)
    .map(r => r.team_name)
    .filter((t): t is string => !!t)
  return NextResponse.json(
    { teams },
    { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
  )
}
