import { NextResponse } from "next/server"
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
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "pack-listings failed" },
      { status: 500 },
    )
  }
}
