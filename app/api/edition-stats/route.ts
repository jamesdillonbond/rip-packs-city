import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// GET /api/edition-stats?editionKey={setID:playID}
// Returns day-of-week and hour-of-day sale patterns for an edition,
// including the top 3 cheapest day+hour combinations as bestTimeToBuy.

const DOW_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

export async function GET(req: NextRequest) {
  const editionKey = req.nextUrl.searchParams.get("editionKey")
  if (!editionKey) {
    return NextResponse.json({ error: "editionKey required" }, { status: 400 })
  }

  try {
    // Resolve edition_id from external_id
    const { data: edition } = await supabaseAdmin
      .from("editions")
      .select("id")
      .eq("external_id", editionKey)
      .single()

    if (!edition?.id) {
      return NextResponse.json({ error: "Edition not found" }, { status: 404 })
    }

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

    // Query sale patterns grouped by day-of-week and hour
    const { data: patterns } = await supabaseAdmin.rpc("execute_sql", {
      query: `
        SELECT
          EXTRACT(dow FROM sold_at)::int AS dow,
          EXTRACT(hour FROM sold_at)::int AS hour,
          ROUND(AVG(price_usd)::numeric, 2) AS avg_price,
          COUNT(*)::int AS sale_count
        FROM sales
        WHERE edition_id = '${edition.id}'
          AND sold_at >= '${cutoff}'
          AND price_usd > 0
        GROUP BY dow, hour
        ORDER BY avg_price ASC
      `,
    })

    const rows = (patterns as { dow: number; hour: number; avg_price: number; sale_count: number }[]) ?? []

    // Build bestTimeToBuy from top 3 cheapest buckets with at least 2 sales
    const qualified = rows.filter((r) => r.sale_count >= 2)
    const bestTimeToBuy = qualified.slice(0, 3).map((r) => ({
      dow: r.dow,
      hour: r.hour,
      label: `${DOW_LABELS[r.dow]} ${r.hour}:00`,
      avg_price: Number(r.avg_price),
      sale_count: r.sale_count,
    }))

    return NextResponse.json(
      { editionKey, bestTimeToBuy, allPatterns: rows },
      { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=600" } }
    )
  } catch (e) {
    console.error("[edition-stats] Error:", e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to compute edition stats" },
      { status: 500 }
    )
  }
}
