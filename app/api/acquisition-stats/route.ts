import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const SLUG_TO_DB_SLUG: Record<string, string> = {
  "nba-top-shot": "nba_top_shot",
  "nfl-all-day": "nfl_all_day",
  "laliga-golazos": "laliga_golazos",
  "disney-pinnacle": "disney_pinnacle",
  "ufc": "ufc",
}

async function resolveCollectionId(input?: string | null): Promise<string> {
  if (!input) return TOPSHOT_COLLECTION_ID
  // Direct UUID pass-through
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
    return input
  }
  const dbSlug = SLUG_TO_DB_SLUG[input] ?? input
  try {
    const { data } = await (supabaseAdmin as any)
      .from("collections")
      .select("id")
      .eq("slug", dbSlug)
      .single()
    return data?.id ?? TOPSHOT_COLLECTION_ID
  } catch {
    return TOPSHOT_COLLECTION_ID
  }
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")
  const collectionParam = req.nextUrl.searchParams.get("collection")
  if (!wallet) {
    return NextResponse.json({ error: "wallet parameter required" }, { status: 400 })
  }

  try {
    const collectionId = await resolveCollectionId(collectionParam)
    const walletAddr = wallet.startsWith("0x") ? wallet : "0x" + wallet
    const { data, error } = await (supabaseAdmin as any).rpc("get_acquisition_stats", {
      p_wallet: walletAddr,
      p_collection_id: collectionId,
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
