// app/api/candy-collections-progress/route.ts
//
// GET /api/candy-collections-progress?wallet=<solana wallet> (2026-11-26) — every Candy collection the wallet
// holds a card of: different cards owned vs catalogued, with its league / brand. The same public holdings the
// Candy Binder shows. GET-only, no session. ⛔ A Solana key is case-sensitive and un-prefixed: it is
// validated and passed through untouched; a non-Solana address is refused (400), never answered with an
// empty list. A failed read is an error response, never "holds nothing".

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { isValidAddressForChain } from "@/lib/address"
import { toCandyCollectionsProgress } from "@/lib/candy/collections-progress"

export const dynamic = "force-dynamic"

const TAG = "api/candy-collections-progress"
const FAIL = "Collection progress is unavailable right now."

export async function GET(req: NextRequest) {
  const wallet = (req.nextUrl.searchParams.get("wallet") ?? "").trim()
  if (!isValidAddressForChain(wallet, "solana")) {
    return NextResponse.json({ error: "Candy lives on Solana — enter a Solana wallet address.", code: "bad_request", retryable: false }, { status: 400 })
  }
  try {
    const db = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<unknown> }
    const res = await boundedRead(db.rpc("candy_wallet_collection_progress", { p_wallet: wallet }), TAG)
    if (res.error) return apiErrorResponse(res.error, TAG, FAIL)
    const progress = toCandyCollectionsProgress(res.data)
    if (!progress) return apiErrorResponse(new Error("collection progress returned an unexpected shape"), TAG, FAIL)
    return NextResponse.json(progress, { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600" } })
  } catch (e) {
    return apiErrorResponse(e, TAG, FAIL)
  }
}
