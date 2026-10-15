// app/api/market/filter-options/route.ts
//
// The full option lists behind the Market page's Set / Series / Team / Badge
// dropdowns and the Player suggestions. The dropdowns used to be built from the 50 listings
// on screen, so a team, set or series with no listing on the current page
// (Portland Fire, 2026-10-14) could not be picked.
//
// Served ONLY for collections whose market filters run against `editions` in
// the database (Top Shot, All Day: get_topshot_sniper_deals_v3 /
// get_allday_market_editions_v3 match btrim(set_name) IN, series::text = ANY,
// team_name ILIKE, player_name ILIKE). Every value get_market_filter_options
// returns is therefore matchable there. Badges come from
// get_market_badge_options: every title in market_edition_badges' latest run,
// the table the v3 RPCs filter `p_badges` against. Other collections filter their own
// boards, so a catalog list could offer a value that matches nothing; they get
// `{ catalog: false }` and the page uses the facets /api/market returns.
//
// An unknown collectionId is refused (400), never defaulted to another
// collection. A failed read answers through apiErrorResponse; the client then
// falls back to the facets.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { getCollectionByUuid, getCollectionUuid } from "@/lib/collections"

const CATALOG_FILTERED = new Set(
  ["nba-top-shot", "nfl-all-day"].map((slug) => getCollectionUuid(slug)).filter((u): u is string => !!u),
)

const KEYS = ["sets", "series", "teams", "players"] as const

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> }

export async function GET(req: NextRequest) {
  const collectionId = req.nextUrl.searchParams.get("collectionId") ?? ""
  if (!getCollectionByUuid(collectionId)) {
    return NextResponse.json({ error: "unknown collectionId" }, { status: 400 })
  }
  const cache = { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" }
  if (!CATALOG_FILTERED.has(collectionId)) {
    return NextResponse.json({ catalog: false }, { headers: cache })
  }

  const db = supabaseAdmin as unknown as Rpc
  const [{ data, error }, badgeRead] = await Promise.all([
    boundedRead(db.rpc("get_market_filter_options", { p_collection_id: collectionId }), "api/market/filter-options/get_market_filter_options"),
    boundedRead(db.rpc("get_market_badge_options", { p_collection_id: collectionId }), "api/market/filter-options/get_market_badge_options"),
  ])
  const failed = error ?? badgeRead.error
  if (failed) {
    console.error("[api/market/filter-options]", failed.message)
    return apiErrorResponse(failed, "api/market/filter-options")
  }
  if (!Array.isArray(badgeRead.data)) {
    return apiErrorResponse(new Error("unexpected get_market_badge_options payload"), "api/market/filter-options")
  }
  // The function returns a jsonb OBJECT of four arrays; anything else is a
  // contract break, not "no options".
  const obj = data != null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null
  if (!obj || !KEYS.every((k) => Array.isArray(obj[k]))) {
    return apiErrorResponse(new Error("unexpected get_market_filter_options payload"), "api/market/filter-options")
  }

  const out: Record<string, string[]> = {}
  for (const k of KEYS) out[k] = (obj[k] as unknown[]).filter((v): v is string => typeof v === "string" && v !== "")
  out.badges = (badgeRead.data as unknown[]).filter((v): v is string => typeof v === "string" && v !== "")
  return NextResponse.json({ catalog: true, ...out }, { headers: cache })
}
