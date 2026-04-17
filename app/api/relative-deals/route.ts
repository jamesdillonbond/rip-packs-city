import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionUuid } from "@/lib/collections"

// ── Relative-deals fallback for ASK_ONLY collections ──────────────────────────
//
// When FMV for a collection is purely ask-derived (Golazos / UFC today),
// "discount off FMV" is circular and the sniper feed returns 0 deals. This
// route exposes the Supabase get_relative_deals RPC, which compares each
// listing's ask against its tier's median ask instead. Paired with
// /api/tier-pricing-benchmarks on the sidebar, it gives users a usable
// ranking even when sales data is thin.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("collection") ?? ""
  const minDiscountRaw = req.nextUrl.searchParams.get("minDiscount")
  const limitRaw = req.nextUrl.searchParams.get("limit")

  const collectionId = getCollectionUuid(slug)
  if (!collectionId) {
    return NextResponse.json(
      { error: `unknown collection: ${slug}` },
      { status: 400 }
    )
  }

  const minDiscount = (() => {
    const n = Number(minDiscountRaw)
    return Number.isFinite(n) && n >= 0 ? n : 10
  })()
  const limit = (() => {
    const n = Number(limitRaw)
    return Number.isFinite(n) && n > 0 && n <= 200 ? Math.floor(n) : 50
  })()

  const { data, error } = await supabaseAdmin.rpc("get_relative_deals", {
    p_collection_id: collectionId,
    p_min_discount: minDiscount,
    p_limit: limit,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const deals = Array.isArray(data) ? data : []
  return NextResponse.json({
    collection: slug,
    minDiscount,
    count: deals.length,
    deals,
    lastRefreshed: new Date().toISOString(),
  })
}
