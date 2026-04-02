import { NextRequest, NextResponse } from "next/server"
import { supabase } from "@/lib/supabase"

export const dynamic = "force-dynamic"

const VALID_SORTS: Record<string, { column: string; ascending: boolean }> = {
  price_asc: { column: "sale_price_usd", ascending: true },
  price_desc: { column: "sale_price_usd", ascending: false },
  serial_asc: { column: "serial_number", ascending: true },
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams

  const variant = params.get("variant")
  const editionType = params.get("editionType")
  const studio = params.get("studio")
  const isChaser = params.get("isChaser")
  const isLocked = params.get("isLocked")
  const sortBy = params.get("sortBy") ?? "price_asc"
  const limit = Math.min(Number(params.get("limit")) || 50, 200)
  const offset = Number(params.get("offset")) || 0

  try {
    // Query editions joined with their latest FMV snapshot and current floor
    // from pinnacle_sales
    let query = supabase
      .from("pinnacle_editions")
      .select(`
        *,
        pinnacle_fmv_snapshots (
          fmv_usd,
          floor_usd,
          confidence,
          computed_at
        )
      `)

    // Apply filters
    if (variant) {
      const variants = variant.split(",")
      query = query.in("variant_type", variants)
    }

    if (editionType) {
      const types = editionType.split(",")
      query = query.in("edition_type", types)
    }

    if (studio) {
      const studios = studio.split(",")
      query = query.in("franchise", studios)
    }

    if (isChaser === "true") {
      query = query.eq("is_chaser", true)
    }

    // Sort — default to price_asc
    // Note: sorting by sale price requires a different approach since
    // price lives in pinnacle_sales. For now, sort by edition columns.
    const sort = VALID_SORTS[sortBy] ?? VALID_SORTS.price_asc
    if (sortBy === "serial_asc") {
      query = query.order("is_serialized", { ascending: false })
    }
    query = query
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1)

    const { data, error, count } = await query

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    // Also fetch current floor prices from pinnacle_sales for each edition
    const editionIds = (data ?? []).map((e: { id: string }) => e.id)
    let floorPrices: Record<string, number> = {}

    if (editionIds.length > 0) {
      const { data: sales } = await supabase
        .from("pinnacle_sales")
        .select("edition_id, sale_price_usd")
        .in("edition_id", editionIds)
        .order("sale_price_usd", { ascending: true })

      if (sales) {
        // Group by edition_id, take lowest price
        for (const sale of sales) {
          if (
            sale.edition_id &&
            (!(sale.edition_id in floorPrices) ||
              sale.sale_price_usd < floorPrices[sale.edition_id])
          ) {
            floorPrices[sale.edition_id] = sale.sale_price_usd
          }
        }
      }
    }

    // Merge floor prices into response
    const enriched = (data ?? []).map((edition: Record<string, unknown>) => ({
      ...edition,
      floor_price_usd: floorPrices[edition.id as string] ?? null,
    }))

    // Sort by price if requested
    if (sortBy === "price_asc" || sortBy === "price_desc") {
      enriched.sort((a: { floor_price_usd: number | null }, b: { floor_price_usd: number | null }) => {
        const pa = a.floor_price_usd ?? Infinity
        const pb = b.floor_price_usd ?? Infinity
        return sortBy === "price_asc" ? pa - pb : pb - pa
      })
    }

    return NextResponse.json({ data: enriched, count: enriched.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
