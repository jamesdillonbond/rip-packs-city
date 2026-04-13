import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")
  if (!wallet) {
    return NextResponse.json({ error: "wallet parameter required" }, { status: 400 })
  }

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_acquisition_stats", {
      p_wallet: wallet,
      p_collection_id: TOPSHOT_COLLECTION_ID,
    })

    if (error) {
      console.log("[acquisition-stats] RPC error:", error.message)
      return NextResponse.json({ error: "Database query failed" }, { status: 500 })
    }

    const result = Array.isArray(data) ? data[0] : data
    return NextResponse.json(result ?? { breakdown: [], total_moments: 0, total_spent: 0, locked_count: 0 })
  } catch (err) {
    console.log("[acquisition-stats] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
