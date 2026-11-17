// app/api/topshot/challenges/route.ts
//
// Active Top Shot Set Challenge board — "which live challenges are worth completing right
// now?". Reads get_active_challenges, which computes cost PER SLOT (each Challenge Builder
// slot = lock one moment of a specific player in the set): the cheapest eligible moment per
// slot (badge_editions.low_ask floor + FMV), minus the wallet's wmc ownership, plus reward
// valuation (reward-pack gross_ev from pack_ev_latest, or reward-moment FMV) — so each
// challenge carries costToComplete, rewardValue, and netEv (airdrop-adjusted: reward × expected packs per completer − cost), the "should I do
// this?" signal nbatopshot.com's own challenge page and third-party trackers don't compute.
//
// Challenge definitions come from the searchChallenges ingest (cron ingest-topshot-challenges,
// slot model) or operator seeds (POST /api/admin/challenges/upsert). Ranked by netEv desc,
// then soonest deadline.
//
// GET /api/topshot/challenges[?wallet=0x…]   (wallet optional → progress/cost is
//                                             wallet-agnostic when omitted)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

export const dynamic = "force-dynamic"

const ADDR_RE = /^0x[a-fA-F0-9]{16}$/

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const wallet = (searchParams.get("wallet") ?? "").trim()

  if (wallet && !ADDR_RE.test(wallet)) {
    return NextResponse.json({ error: "wallet must be a 0x + 16 hex Flow address" }, { status: 400 })
  }

  try {
    const { data, error } = await boundedRead((supabaseAdmin as any).rpc("get_active_challenges", {
      p_wallet: wallet || null,
    }), "api/topshot/challenges/get_active_challenges")
    if (error) {
      return apiErrorResponse(error, "api/topshot/challenges")
    }
    return NextResponse.json(data ?? { challenges: [], activeCount: 0 }, { status: 200 })
  } catch (e) {
    return apiErrorResponse(e, "topshot/challenges", "Challenges aren't available right now.")
  }
}
