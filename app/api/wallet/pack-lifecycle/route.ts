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

  const { data: matches, error: lookupErr } = await sb
    .from("saved_wallets")
    .select("wallet_addr")
    .eq("user_id", user.id)
    .eq("wallet_addr", wallet)
    .not("verified_at", "is", null)
    .limit(1)

  if (lookupErr) {
    return NextResponse.json({ error: lookupErr.message }, { status: 500 })
  }
  if (!matches || matches.length === 0) {
    return NextResponse.json({ error: "wallet not verified on this account" }, { status: 403 })
  }

  try {
    const { data, error } = await sb.rpc("get_pack_lifecycle", { p_pack_nft_id: packNftId })
    if (error) {
      console.error("[wallet/pack-lifecycle]", error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json(data ?? {}, {
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
