// app/api/trade-hub/matches/route.ts
//
// Returns the current user's pending trade_matches (rows where they are the
// buyer or seller and resolved_at IS NULL). Auth: Supabase cookie.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCurrentUser } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

  // Optionally trigger compute_trade_matches before reading so the surface is
  // fresh for the requesting user. Pass ?recompute=true to opt in.
  const recompute = req.nextUrl.searchParams.get("recompute") === "true"
  if (recompute) {
    try {
      await (supabaseAdmin as any).rpc("compute_trade_matches", {
        p_user_id: user.id,
        p_min_score: 50,
      })
    } catch (e) {
      console.log("[trade-hub/matches] compute err:", e instanceof Error ? e.message : String(e))
    }
  }

  const { data, error } = await (supabaseAdmin as any)
    .from("trade_matches")
    .select("id, wishlist_id, offer_id, buyer_user_id, seller_user_id, edition_id, collection_id, match_score, reason, surfaced_at, buyer_notified, seller_notified, resolved_at, resolution")
    .or(`buyer_user_id.eq.${user.id},seller_user_id.eq.${user.id}`)
    .is("resolved_at", null)
    .order("match_score", { ascending: false, nullsFirst: false })
    .order("surfaced_at", { ascending: false })
    .limit(100)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, matches: data ?? [] })
}
