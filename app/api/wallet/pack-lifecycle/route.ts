// app/api/wallet/pack-lifecycle/route.ts
//
// GET /api/wallet/pack-lifecycle?wallet=<addr>&packNftId=<id>
//
// Auth: requires a Supabase user session; verifies the requested wallet
// belongs to the user. Backs the inline-expand row in /dashboard/packs by
// calling get_pack_lifecycle(p_pack_nft_id text). The public lifecycle page
// at /[collection]/pack/[id] is anon-safe, but the dashboard view is keyed
// to the signed-in user's wallets so we gate it the same way as the summary
// and history endpoints — defense-in-depth.

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
  const packNftId = (req.nextUrl.searchParams.get("packNftId") ?? "").trim()
  if (!wallet || !packNftId) {
    return NextResponse.json({ error: "wallet and packNftId required" }, { status: 400 })
  }

  // 2026-09-06 (Trevor delegated the decision): the gate is "SAVED on this
  // account", no longer "VERIFIED". Verification-by-listing has had no live data
  // source since ~08-28 (public-api.nbatopshot.com is gone), so 0 wallets could
  // verify and this route was unreachable for every new user — while everything
  // it returns is public on-chain data. Ownership of the READ still requires the
  // wallet to be on the caller's account. known-issues #59.
  const { data: matches, error: lookupErr } = await boundedRead(sb
    .from("saved_wallets")
    .select("wallet_addr")
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .limit(1), "api/wallet/pack-lifecycle/saved-wallets")

  if (lookupErr) {
    return apiErrorResponse(lookupErr, "api/wallet/pack-lifecycle");
  }
  if (!matches || matches.length === 0) {
    return NextResponse.json({ error: "wallet not saved on this account" }, { status: 403 })
  }

  try {
    const { data, error } = await boundedRead(sb.rpc("get_pack_lifecycle", { p_pack_nft_id: packNftId }), "api/wallet/pack-lifecycle/get_pack_lifecycle")
    if (error) {
      console.error("[wallet/pack-lifecycle]", error.message)
      return apiErrorResponse(error, "api/wallet/pack-lifecycle");
    }
    return NextResponse.json(data ?? {}, {
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    })
  } catch (err) {
    return apiErrorResponse(err, "api/wallet/pack-lifecycle");
  }
}
