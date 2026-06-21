// app/api/public/insights/pack-sniper/route.ts
//
// PUBLIC INSIGHTS — Pack Sniper deal feed.
//
// Read-only JSON endpoint backing the /insights/pack-sniper page. Lives under
// /api/public/* so the proxy.ts allowlist lets it through with no auth. The
// deal logic (live Dapper Studio asks joined to pack_table_rows EV, honesty
// gates, rank-by-live-value-ratio) lives in lib/packs/pack-deals.ts and is
// shared with the server-rendered board.
//
// Why this exists: ~27% of dist-resolved Top Shot secondary sealed-pack sales
// clear below 80% of the pack's gross EV (live query 2026-06-09). Top Shot's
// own marketplace surfaces a flat low-ask with no EV anchor. This board ranks
// currently-listed packs by live ask vs expected pull value — with a
// high-variance flag so chance-hit / single-chase "90x" lottery packs are
// labelled, not promoted.
//
// Query params:
//   collection=nba-top-shot|nfl-all-day   default nba-top-shot
//   limit=<1..200>                        default 50
//   include_high_variance=true|false      default true (UI decides display)
//
// Response: { meta, deals }
//
// CACHE: 5-minute s-maxage. The upstream live-listings fetch is itself memoized
// 2 minutes, so a 5-minute CDN cache keeps anon traffic off Dapper Studio.

import { NextRequest, NextResponse } from "next/server"
import { getPackDeals } from "@/lib/packs/pack-deals"
import { SUPPORTED_PACK_COLLECTIONS, isSupportedPackCollection } from "@/lib/packs/live-pack-listings"

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const sp = new URL(req.url).searchParams

  const collection = sp.get("collection") ?? "nba-top-shot"
  if (!isSupportedPackCollection(collection)) {
    return NextResponse.json(
      { error: `collection must be one of: ${SUPPORTED_PACK_COLLECTIONS.join(", ")}` },
      { status: 400 },
    )
  }
  const limit = Math.max(1, Math.min(200, Number(sp.get("limit") ?? "50")))
  const includeHighVariance = sp.get("include_high_variance") !== "false"

  try {
    const result = await getPackDeals(collection, { limit, includeHighVariance })
    const elapsedMs = Date.now() - startedAt
    console.log(
      `[public/insights/pack-sniper] collection=${collection} returned=${result.stats.returned} ` +
        `matched=${result.stats.matched} posEv=${result.stats.positiveEv} hiVar=${result.stats.highVariance} ` +
        `liveListings=${result.stats.liveListings} elapsedMs=${elapsedMs}`,
    )

    const res = NextResponse.json({
      meta: {
        fetched_at: new Date().toISOString(),
        source: "live:dapper-studio + pack_table_rows",
        collection,
        elapsed_ms: elapsedMs,
        filters: { limit, include_high_variance: includeHighVariance },
        stats: result.stats,
      },
      deals: result.deals,
    })
    res.headers.set("Cache-Control", "public, s-maxage=60, stale-while-revalidate=30")
    return res
  } catch (e) {
    console.error("[public/insights/pack-sniper]", e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "pack-sniper failed" },
      { status: 500 },
    )
  }
}
