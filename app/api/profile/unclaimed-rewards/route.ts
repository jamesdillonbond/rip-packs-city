// app/api/profile/unclaimed-rewards/route.ts
//
// GET → { rewards: UnclaimedReward[] } — reward packs the signed-in account earned
// (a completed trophy-challenge case) and has not claimed yet (2026-11-15). Feeds
// the dashboard's "Your reward pack is waiting" card. A failed read is a 503 via
// apiErrorResponse, never `{ rewards: [] }`: the card then renders nothing, which is
// the honest answer for "we could not tell".

import { NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { requireUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"
import { unclaimedRewardsForUser } from "@/lib/giveaways/challenge-reward"

export const dynamic = "force-dynamic"

const ROUTE = "api/profile/unclaimed-rewards"

export async function GET() {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }
  try {
    const rewards = await unclaimedRewardsForUser(supabaseAdmin as never, user.id)
    return NextResponse.json({ rewards }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    return apiErrorResponse(err, ROUTE, "Couldn't check your challenge rewards.")
  }
}
