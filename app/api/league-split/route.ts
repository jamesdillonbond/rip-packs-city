// app/api/league-split/route.ts
//
// A collector's Panini or Candy cards by league / brand (2026-11-26):
//   GET /api/league-split?publisher=panini&owner=<panini username>
//   GET /api/league-split?publisher=candy&owner=<solana wallet>
// The same public holdings the Binder tabs show (a Panini username's walked cards; a Solana wallet's Candy
// cards), grouped by publisher_properties. GET-only, no session. ⛔ A Solana key is case-sensitive and
// un-prefixed — it is validated and passed through untouched (never lower-cased; lib/address.ts).
// A failed read is an error response, never an empty split.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { isValidAddressForChain } from "@/lib/address"
import { toLeagueSplit } from "@/lib/league-split"

export const dynamic = "force-dynamic"

const TAG = "api/league-split"
const FAIL = "The league breakdown is unavailable right now."
const bad = (error: string) => NextResponse.json({ error, code: "bad_request", retryable: false }, { status: 400 })

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const publisher = sp.get("publisher")
  const owner = (sp.get("owner") ?? "").trim()
  if (publisher !== "panini" && publisher !== "candy") return bad("unknown publisher")
  if (publisher === "panini" ? !/^[^\s/\\]{1,64}$/.test(owner) : !isValidAddressForChain(owner, "solana")) return bad("unknown owner")
  try {
    const db = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<unknown> }
    const res = await boundedRead(
      publisher === "panini" ? db.rpc("panini_owner_property_split", { p_username: owner }) : db.rpc("candy_wallet_property_split", { p_wallet: owner }),
      `${TAG}/${publisher}`,
    )
    if (res.error) return apiErrorResponse(res.error, TAG, FAIL)
    const split = toLeagueSplit(res.data)
    if (!split) return apiErrorResponse(new Error("league split returned an unexpected shape"), TAG, FAIL)
    return NextResponse.json(split, { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600" } })
  } catch (e) {
    return apiErrorResponse(e, TAG, FAIL)
  }
}
