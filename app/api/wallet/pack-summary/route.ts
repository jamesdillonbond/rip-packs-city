// app/api/wallet/pack-summary/route.ts
//
// GET /api/wallet/pack-summary?wallet=<addr>
//
// Auth: requires a Supabase user session; verifies the requested wallet
// is SAVED on the user's account (saved_wallets; verification no longer gates — 09-06, #59).
//
// Wraps get_wallet_pack_summary(p_wallet text) which returns jsonb with
// { totals, by_currency, by_collection, note, wallet, computed_at }.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
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
  // saved_wallets. We collapse across collections so a wallet saved under any
  // collection unlocks history reads.
  // 2026-09-06 (Trevor delegated the decision): the gate is "SAVED on this
  // account", no longer "VERIFIED". Verification-by-listing has had no live data
  // source since ~08-28 (public-api.nbatopshot.com is gone), so 0 wallets could
  // verify and this route was unreachable for every new user — while everything
  // it returns is public on-chain data. Ownership of the READ still requires the
  // wallet to be on the caller's account. known-issues #59.
  const { data: matches, error: lookupErr } = await boundedRead(sb
    .from("saved_wallets")
    .select("wallet_addr, verified_at")
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .limit(1), "api/wallet/pack-summary/saved_wallets")

  if (lookupErr) {
    console.error("[wallet/pack-summary] verify lookup", lookupErr.message)
    return apiErrorResponse(lookupErr, "api/wallet/pack-summary");
  }
  if (!matches || matches.length === 0) {
    return NextResponse.json(
      { error: "wallet not saved on this account" },
      { status: 403 },
    )
  }

  try {
    const { data, error } = await boundedRead(sb.rpc("get_wallet_pack_summary", {
      p_wallet: wallet,
    }), "api/wallet/pack-summary/get_wallet_pack_summary")
    if (error) {
      console.error("[wallet/pack-summary]", error.message)
      return apiErrorResponse(error, "api/wallet/pack-summary");
    }
    return NextResponse.json(data ?? {}, {
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[wallet/pack-summary] unexpected", msg)
    return apiErrorResponse(err, "api/wallet/pack-summary");
  }
}
