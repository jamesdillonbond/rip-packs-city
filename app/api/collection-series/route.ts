import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollection } from "@/lib/collections"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

/**
 * GET /api/collection-series?collection=nfl-all-day
 *
 * Returns the series entries for a given collection from collection_series table.
 * Used by the collection page to populate the series filter dropdown dynamically.
 */
export async function GET(req: NextRequest) {
  const collectionSlug = req.nextUrl.searchParams.get("collection") ?? "nba-top-shot"
  const collectionObj = getCollection(collectionSlug)
  if (!collectionObj) {
    return NextResponse.json({ error: "Unknown collection" }, { status: 400 })
  }

  // Look up collection UUID from collection_config using flow_contract_name
  const contractName = collectionObj.flowContractName
  if (!contractName) {
    return NextResponse.json({ series: [] })
  }

  // ⚠ THERE ARE THREE STATES HERE, NOT TWO — read failed / read ok + no config
  // row / read ok + config found. Both reads below used to swallow `error`, and
  // supabase-js RETURNS errors rather than throwing, so a failed read resolved
  // `{ data: null, error }` and fell straight into the `{ series: [] }` branch.
  // The consumer (CollectionTabClient) then sets an EMPTY series filter, i.e.
  // the page states "this collection has no series" out of a timeout — and the
  // success path is cached `s-maxage=300, stale-while-revalidate=600`, so one
  // failed read served that claim to every visitor for up to 15 minutes.
  //
  // ⚠ `.single()` → `.maybeSingle()` is load-bearing, not tidying: `.single()`
  // raises PGRST116 when it matches zero rows, so "this collection has no
  // config row" and "the read failed" arrived as the SAME error and could not
  // be told apart. Same fix as app/api/edition-stats.
  //
  // ⚠ The error responses carry `Cache-Control: no-store` (apiErrorResponse),
  // which is what keeps a transient failure from being cached for 15 minutes.
  // The cache header below must stay on the SUCCESS path only.
  const { data: config, error: configError } = await boundedRead((supabaseAdmin as any)
    .from("collection_config")
    .select("collection_id")
    .eq("flow_contract_name", contractName)
    .maybeSingle(), "api/collection-series/collection_config")

  if (configError) {
    return apiErrorResponse(configError, "collection-series/config", "Series filters are unavailable right now.")
  }

  // Genuinely absent, not unreadable — an honest empty.
  if (!config?.collection_id) {
    return NextResponse.json({ series: [] })
  }

  const { data: series, error: seriesError } = await boundedRead((supabaseAdmin as any)
    .from("collection_series")
    .select("series_number, display_label, season")
    .eq("collection_id", config.collection_id)
    .order("series_number", { ascending: true }), "api/collection-series/collection_series")

  if (seriesError) {
    return apiErrorResponse(seriesError, "collection-series/series", "Series filters are unavailable right now.")
  }

  return NextResponse.json(
    { series: series ?? [] },
    {
      // Global + near-static per collection — safe to share at the edge.
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    },
  )
}
