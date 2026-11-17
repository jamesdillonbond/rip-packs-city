// app/api/topshot/challenge-plan/route.ts
//
// Per-challenge completion plan — one row per required SLOT for a Challenge Builder set
// challenge (each slot = lock one moment of a specific player in the set). Each slot carries
// whether the wallet already owns an eligible moment (filled) and the cheapest eligible
// moment to buy if not (the actionable pick), with floor (badge_editions.low_ask), FMV, and
// per-edition lock/burn pressure (badge_editions.lock_rate_pct/burn_rate_pct). Header carries
// costToComplete (sum of cheapest eligible per unfilled slot), rewardValue, netEv, and
// unresolvedSlots (slots whose edition isn't indexed yet).
//
// Slots are ranked unfilled-then-cheapest and each pick deep-links to our own edition page
// (which carries the live "View Listing" out to Top Shot).
//
// GET /api/topshot/challenge-plan?challengeId=<uuid>[&wallet=0x…]

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ADDR_RE = /^0x[a-fA-F0-9]{16}$/

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const challengeId = (searchParams.get("challengeId") ?? "").trim()
  const wallet = (searchParams.get("wallet") ?? "").trim()

  if (!UUID_RE.test(challengeId)) {
    return NextResponse.json({ error: "challengeId must be a challenge UUID" }, { status: 400 })
  }
  if (wallet && !ADDR_RE.test(wallet)) {
    return NextResponse.json({ error: "wallet must be a 0x + 16 hex Flow address" }, { status: 400 })
  }

  try {
    const { data, error } = await boundedRead((supabaseAdmin as any).rpc("get_challenge_plan", {
      p_wallet: wallet || "",
      p_challenge_id: challengeId,
    }), "api/topshot/challenge-plan/get_challenge_plan")
    if (error) {
      return apiErrorResponse(error, "api/topshot/challenge-plan")
    }
    if (!data || !data.name) {
      return NextResponse.json({ error: "challenge not found" }, { status: 404 })
    }
    return NextResponse.json(data, { status: 200 })
  } catch (e) {
    return apiErrorResponse(e, "topshot/challenge-plan", "This challenge plan isn't available right now.")
  }
}
