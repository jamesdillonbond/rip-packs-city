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

  // ⛔ 2026-09-19 — THE EARLY RETURN HERE WAS THE RIGHT ANSWER FOR THE WRONG
  // REASON. It read `if (!contractName) return { series: [] }`, so Candy MLB —
  // on Solana, with no Flow contract — published "this collection has no
  // series" from a lookup that never asked the series table anything.
  //
  // That answer is TRUE today (measured: `collection_series` holds 26 rows and
  // every one belongs to one of the five Flow collections), and that is exactly
  // what made it a TRAP rather than a bug: seed one Candy row tomorrow and the
  // route would still answer `[]`, silently and forever. This file already
  // draws the distinction for the failure case — its own comment below marks
  // the no-config branch "Genuinely absent, not unreadable — an honest empty".
  // An empty that never looked is neither.
  //
  // ⚠ DELIBERATELY THE SMALLEST POSSIBLE CHANGE: the Flow path is untouched,
  // contract lookup and all. A first attempt preferred the registry UUID for
  // EVERY collection and skipped the `collection_config` read — which was
  // tidier, and wrong: it made that read dead code for all five Flow
  // collections and thereby made this suite's config-read-failure arm
  // unreachable. A guard that can no longer fire is worse than no guard, and
  // the existing test caught it. Registry UUID is the fallback for a
  // collection with NO Flow contract, and nothing else changes.
  const contractName = collectionObj.flowContractName
  if (!contractName) {
    const registryId = collectionObj.supabaseCollectionId
    // No Flow contract AND no DB identity — an unpublished placeholder, which
    // really is honestly empty.
    if (!registryId) return NextResponse.json({ series: [] })
    const { data: series, error: seriesError } = await boundedRead((supabaseAdmin as any)
      .from("collection_series")
      .select("series_number, display_label, season")
      .eq("collection_id", registryId)
      .order("series_number", { ascending: true }), "api/collection-series/collection_series")
    if (seriesError) {
      return apiErrorResponse(seriesError, "collection-series/series", "Series filters are unavailable right now.")
    }
    return NextResponse.json(
      { series: series ?? [] },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
    )
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
