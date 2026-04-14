import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

export async function GET(req: NextRequest) {
  const walletInput = req.nextUrl.searchParams.get("wallet")
  if (!walletInput) return NextResponse.json({ error: "wallet required" }, { status: 400 })
  const wallet = walletInput.trim().startsWith("0x") ? walletInput.trim() : `0x${walletInput.trim()}`
  const collectionId = req.nextUrl.searchParams.get("collection_id") || TOPSHOT_COLLECTION_ID

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_marketplace_breakdown", {
      p_wallet: wallet,
      p_collection_id: collectionId,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const result = Array.isArray(data) ? data[0] : data
    return NextResponse.json(result ?? {})
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "internal error" }, { status: 500 })
  }
}
