import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

export async function GET(req: NextRequest) {
  const walletInput = req.nextUrl.searchParams.get("wallet")
  if (!walletInput) return NextResponse.json({ error: "wallet required" }, { status: 400 })
  const wallet = walletInput.trim().startsWith("0x") ? walletInput.trim() : `0x${walletInput.trim()}`
  const collectionId = req.nextUrl.searchParams.get("collection_id") || TOPSHOT_COLLECTION_ID

  try {
    const { data, error } = await boundedRead((supabaseAdmin as any).rpc("get_marketplace_breakdown", {
      p_wallet: wallet,
      p_collection_id: collectionId,
    }), "api/marketplace-breakdown/get_marketplace_breakdown")
    if (error) return apiErrorResponse(error, "api/marketplace-breakdown")
    const result = Array.isArray(data) ? data[0] : data
    return NextResponse.json(result ?? {})
  } catch (err) {
    return apiErrorResponse(err, "marketplace-breakdown", "This data isn't available right now.")
  }
}
