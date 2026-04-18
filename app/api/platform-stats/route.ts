import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export async function GET() {
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_platform_stats")

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
