import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET(req: NextRequest) {
  const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? 50)
  const minDiscountParam = Number(req.nextUrl.searchParams.get("minDiscount") ?? 5)

  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 50, 1), 200)
  const minDiscount = Number.isFinite(minDiscountParam) ? minDiscountParam : 5

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_cross_collection_deals", {
      p_limit: limit,
      p_min_discount: minDiscount,
    })

    if (error) {
      console.log("[cross-collection-deals] RPC error:", error.message)
      return NextResponse.json({ error: "Database query failed" }, { status: 500 })
    }

    return NextResponse.json(data ?? { deals: [], per_collection: {} }, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=120",
      },
    })
  } catch (err) {
    console.log("[cross-collection-deals] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
