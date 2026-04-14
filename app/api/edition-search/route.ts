import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim()
  if (!q) return NextResponse.json({ results: [] })

  try {
    let query = supabase
      .from("editions")
      .select("id, external_id, player_name, set_name, tier, collection_id")
      .limit(10)

    // If the query looks like an edition key (e.g., "84:2892"), try exact.
    if (/^\d+:\d+$/.test(q)) {
      query = query.eq("external_id", q)
    } else {
      query = query.ilike("player_name", `%${q}%`)
    }

    const { data, error } = await query
    if (error) {
      console.error("[edition-search]", error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const results = (data ?? []).map((r: any) => ({
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
