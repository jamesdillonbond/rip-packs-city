import { NextRequest, NextResponse } from "next/server"
import { supabase } from "@/lib/supabase"

// GET /api/pinnacle/listings — query pinnacle editions with filters
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams

  const variant = params.getAll("variant")
  const editionType = params.getAll("editionType")
  const studio = params.getAll("studio")
  const isChaser = params.get("isChaser")
  const isLocked = params.get("isLocked")
  const sortBy = params.get("sortBy") ?? "price_asc"
  const limit = Math.min(Number(params.get("limit") ?? 50), 200)
  const offset = Number(params.get("offset") ?? 0)

  try {
    let query = supabase
      .from("pinnacle_editions")
      .select("*, pinnacle_fmv_snapshots!inner(fmv_usd, fmv_confidence, floor_price_usd, created_at)")

    // Try joined query first; fall back to editions-only if snapshot table is empty
    const { count: snapshotCount } = await supabase
      .from("pinnacle_fmv_snapshots")
      .select("id", { count: "exact", head: true })

    // If no snapshots exist yet, just query editions directly
    if (!snapshotCount || snapshotCount === 0) {
      query = supabase.from("pinnacle_editions").select("*")
    }

    // Apply filters
    if (variant.length > 0) {
      query = query.in("variant", variant)
    }
    if (editionType.length > 0) {
      query = query.in("edition_type", editionType)
    }
    if (studio.length > 0) {
      query = query.in("studios", studio)
    }
    if (isChaser === "true") {
      query = query.eq("is_chaser", true)
    }

    // Sorting
    switch (sortBy) {
      case "price_desc":
        query = query.order("floor_price_usd", { ascending: false, nullsFirst: false })
        break
      case "serial_asc":
        query = query.order("edition_key", { ascending: true })
        break
      case "price_asc":
      default:
        query = query.order("floor_price_usd", { ascending: true, nullsFirst: false })
        break
    }

    query = query.range(offset, offset + limit - 1)

    const { data, error } = await query

    if (error) {
      console.error("[PINNACLE_LISTINGS]", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      count: data?.length ?? 0,
      offset,
      limit,
      listings: data ?? [],
    })
  } catch (err) {
    console.error("[PINNACLE_LISTINGS_500]", err)
    return NextResponse.json(
      { error: "Failed to fetch listings" },
      { status: 500 }
    )
  }
}
