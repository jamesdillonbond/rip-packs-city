import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionUuid } from "@/lib/collections"

// ── Tier-pricing benchmarks (sidebar reference table) ─────────────────────────
//
// Returns {tier: {count, floor, p25, median, avg, p75}} for the given
// collection's active cached_listings. Pairs with the relative-deals
// fallback on the sniper page so collectors can see where each listing
// sits in its tier's distribution.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("collection") ?? ""

  const collectionId = getCollectionUuid(slug)
  if (!collectionId) {
    return NextResponse.json(
      { error: `unknown collection: ${slug}` },
      { status: 400 }
    )
  }

  const { data, error } = await supabaseAdmin.rpc(
    "get_tier_pricing_benchmarks",
    { p_collection_id: collectionId }
  )
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    collection: slug,
    benchmarks: data ?? {},
    lastRefreshed: new Date().toISOString(),
  })
}
