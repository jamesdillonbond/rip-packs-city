import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET(req: NextRequest) {
  const collection = req.nextUrl.searchParams.get("collection")
  if (!collection) {
    return NextResponse.json({ error: "collection param required" }, { status: 400 })
  }

  const normalized = collection.replace(/-/g, "_")

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_collection_stats", {
      p_slug: normalized,
    })

    if (error) {
      return NextResponse.json(
        { error: "stats_unavailable" },
        {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          },
        }
      )
    }

    if (data && typeof data === "object" && !Array.isArray(data) && (data as any).error) {
      return NextResponse.json(data, { status: 404 })
    }

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "s-maxage=300, stale-while-revalidate=60",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch {
    return NextResponse.json(
      { error: "stats_unavailable" },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      }
    )
  }
}
