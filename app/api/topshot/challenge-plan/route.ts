// app/api/topshot/challenge-plan/route.ts
//
// Per-challenge completion plan — the full required-moment list for one Top Shot
// challenge, split into owned vs missing for a wallet, each missing play carrying the
// current floor (badge_editions.low_ask), FMV, and per-edition lock/burn pressure
// (badge_editions.lock_rate_pct/burn_rate_pct — the supply signal that matters for
// set-locking and crafting challenges). Header carries costToComplete, rewardValue,
// and netEv so the caller can render "finishing this is +$X / −$X vs the reward".
//
// Missing plays are ranked cheapest-first and deep-linked to our own edition page
// (which carries the live "View Listing" out to Top Shot).
//
// GET /api/topshot/challenge-plan?challengeId=<uuid>[&wallet=0x…]

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

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
    const { data, error } = await (supabaseAdmin as any).rpc("get_challenge_plan", {
      p_wallet: wallet || "",
      p_challenge_id: challengeId,
    })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data || !data.name) {
      return NextResponse.json({ error: "challenge not found" }, { status: 404 })
    }
    return NextResponse.json(data, { status: 200 })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
