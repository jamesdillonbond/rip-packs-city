import { NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import {
  fetchLivePackListings,
  isSupportedPackCollection,
  SUPPORTED_PACK_COLLECTIONS,
} from "@/lib/packs/live-pack-listings"

// Live sealed-pack secondary listings from the Dapper Studio internal GraphQL
// endpoint. The fetch + aggregation + 2-minute cache live in
// lib/packs/live-pack-listings.ts so the Pack Sniper deal feed
// (lib/packs/pack-deals.ts) shares the same fetch instead of hitting Dapper
// Studio twice. This route is the thin HTTP wrapper; response shape is
// unchanged from the pre-2026-06-09 inline implementation.

export type { PackListing, PackType } from "@/lib/packs/live-pack-listings"

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const collection = url.searchParams.get("collection") ?? "nba-top-shot"
    if (!isSupportedPackCollection(collection)) {
      return NextResponse.json(
        {
          error: `Unsupported collection '${collection}'. Allowed: ${SUPPORTED_PACK_COLLECTIONS.join(", ")}`,
        },
        { status: 400 },
      )
    }

    const { listings, cached } = await fetchLivePackListings(collection)
    if (cached) {
      return NextResponse.json({ listings, cached: true, collection })
    }
    return NextResponse.json({ listings, cached: false, totalPacks: listings.length, collection })
  } catch (e) {
    // The thrown value here is UPSTREAM text, not ours: fetchLivePackListings
    // rethrows Dapper Studio's internal GraphQL error verbatim
    // (`throw new Error(json.errors[0]?.message)`), and a transport failure
    // carries the raw fetch/undici message. Publishing either hands a signed-in
    // visitor the internal wording of a third-party endpoint we do not control
    // and cannot vouch for the contents of.
    //
    // This is the same inline-ternary spelling of the driver-message leak that
    // lib/api-error.ts was written for. The anon guard
    // (__tests__/anon-api-no-driver-message-leak-guard.test.ts) does not reach
    // this route because /api/pack-listings is not in proxy.ts's
    // PUBLIC_READ_APIS — the leak was to authenticated users, which is why it
    // outlived the anon sweeps.
    //
    // The 400 above is deliberately left hand-rolled: it is a caller error whose
    // copy names the allowed collections, not a driver message, and
    // PackPageClient documents that branch as intentional.
    return apiErrorResponse(e, "api/pack-listings", "Pack listings are unavailable right now.")
  }
}
