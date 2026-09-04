import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { keepCanonicalEditionRows } from "@/lib/concierge/edition-listings"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"

/** Returned to the caller. */
const EDITION_SEARCH_RESULT_LIMIT = 10
/** Fetched before de-duplication — Top Shot can contribute two rows per moment. */
const EDITION_SEARCH_FETCH_LIMIT = 30

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim()
  if (!q) return NextResponse.json({ results: [] })

  try {
    // ⚠ OVER-FETCH, then de-duplicate, then slice to 10. `editions` stores every
    // Top Shot moment under BOTH the int `setID:playID` key and a UUID pair, so
    // an unfiltered name search returns each moment twice — and this route
    // backs the alert-create modal, where the two rows are indistinguishable on
    // screen. Picking the UUID-keyed one would create an alert against an FMV
    // that is NOT maintained: measured 2026-08-15, twin snapshots average 63.4
    // days old (max 75, 6,263 of 6,426 over a month) while canonical ones
    // average 1.2 days and none exceed 7. The alert would simply never fire
    // correctly. Filtering after a .limit(10) would instead return fewer than
    // ten results, so the cap is applied last.
    let query = supabase
      .from("editions")
      .select("id, external_id, player_name, set_name, tier, collection_id")
      .limit(EDITION_SEARCH_FETCH_LIMIT)

    // If the query looks like an edition key (e.g., "84:2892"), try exact.
    // That branch is already canonical by construction — the pattern only
    // matches the int convention.
    if (/^\d+:\d+$/.test(q)) {
      query = query.eq("external_id", q)
    } else {
      query = query.ilike("player_name", `%${q}%`)
    }

    const { data, error } = await boundedRead(query, "api/edition-search/editions")
    if (error) {
      console.error("[edition-search]", error.message)
      return apiErrorResponse(error, "api/edition-search");
    }

    // Row-aware: this search is NOT scoped to a collection, so each row is
    // judged by its own collection_id. Every non-Top-Shot collection is
    // legitimately UUID-keyed and must pass through untouched.
    const deduped = keepCanonicalEditionRows(
      (data ?? []) as Array<{ external_id: string | null; collection_id: string | null }>,
      COLLECTION_UUID_BY_SLUG["nba-top-shot"] ?? "",
    ).slice(0, EDITION_SEARCH_RESULT_LIMIT)

    const results = deduped.map((r: any) => ({
      id: r.id,
      external_id: r.external_id,
      player_name: r.player_name,
      set_name: r.set_name,
      tier: r.tier,
      collection_id: r.collection_id,
    }))
    return NextResponse.json({ results })
  } catch (err: any) {
    console.error("[edition-search] unexpected", err?.message)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
