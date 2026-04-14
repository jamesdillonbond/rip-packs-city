import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(req: NextRequest) {
  const packListingId = req.nextUrl.searchParams.get("packListingId") ?? ""
  if (!packListingId) {
    return NextResponse.json({ error: "packListingId is required" }, { status: 400 })
  }
  const daysRaw = Number(req.nextUrl.searchParams.get("days") ?? "14")
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.floor(daysRaw), 90) : 14

  const { data, error } = await supabase.rpc("get_pack_ev_history", {
    p_pack_listing_id: packListingId,
    p_days: days,
  })

  if (error) {
    console.warn(`[pack-ev-history] rpc error: ${error.message}`)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    packListingId,
    days,
    history: Array.isArray(data) ? data : [],
  })
}
