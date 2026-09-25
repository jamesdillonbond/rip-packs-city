import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { getCollectionUuid } from "@/lib/collections"

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

export async function GET(req: NextRequest) {
  const walletInput = req.nextUrl.searchParams.get("wallet")
  if (!walletInput) return NextResponse.json({ error: "wallet required" }, { status: 400 })
  const wallet = walletInput.trim().startsWith("0x") ? walletInput.trim() : `0x${walletInput.trim()}`
  // ⛔ 2026-09-25 — a NAMED collection is resolved or refused, never swapped for
  // Top Shot (an ABSENT one may still default; the only caller is Top Shot's
  // analytics tab, which now names it).
  const rawCollectionId = req.nextUrl.searchParams.get("collection_id")
  const rawSlug = req.nextUrl.searchParams.get("collection")
  let collectionId = TOPSHOT_COLLECTION_ID
  if (rawCollectionId) {
    collectionId = rawCollectionId
  } else if (rawSlug) {
    const fromSlug = getCollectionUuid(rawSlug)
    if (!fromSlug) {
      return NextResponse.json(
        { error: "collection_not_supported", message: `No collection named ${rawSlug}.` },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      )
    }
    collectionId = fromSlug
  }

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
