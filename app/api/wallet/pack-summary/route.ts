// app/api/wallet/pack-summary/route.ts
//
// GET /api/wallet/pack-summary?wallet=<addr>
//
// Auth: requires a Supabase user session; verifies the requested wallet
// belongs to the user via saved_wallets.verified_at IS NOT NULL.
//
// Wraps get_wallet_pack_summary(p_wallet text) which returns jsonb with
// { totals, by_currency, by_collection, note, wallet, computed_at }.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

export async function GET(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  const wallet = (req.nextUrl.searchParams.get("wallet") ?? "").toLowerCase().trim()
  if (!wallet) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }

  // Wallet ownership check: the requested wallet must appear in the caller's
  // saved_wallets and be verified. We collapse across collections so a wallet
  // verified once under any collection unlocks history reads.
  const { data: matches, error: lookupErr } = await sb
    .from("saved_wallets")
    .select("wallet_addr, verified_at")
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .not("verified_at", "is", null)
    .limit(1)

  if (lookupErr) {
    console.error("[wallet/pack-summary] verify lookup", lookupErr.message)
    return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  }
  if (!matches || matches.length === 0) {
    return NextResponse.json(
      { error: "wallet not verified on this account" },
      { status: 403 },
    )
  }

  try {
    const { data, error } = await sb.rpc("get_wallet_pack_summary", {
      p_wallet: wallet,
    })
    if (error) {
      console.error("[wallet/pack-summary]", error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json(data ?? {}, {
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[wallet/pack-summary] unexpected", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
