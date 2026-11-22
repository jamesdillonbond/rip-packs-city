// app/api/profile/held-pack-value/route.ts
//
// GET /api/profile/held-pack-value
//
// Sealed packs held across EVERY wallet saved on the signed-in account, valued at
// the lowest live ask — shown beside the aggregated wallet value on /dashboard
// (Trevor, 2026-11-21). The read itself lives in lib/packs/held-pack-total.ts,
// shared with the public profile's /api/public/profile/<username>/packs.
//
// Auth: Supabase user session. Takes no wallet parameter — the addresses come
// from the caller's own saved_wallets, so there is nothing to spoof.

import { NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { supabaseAdmin } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"
import { packWalletAddresses, readHeldPackTotal } from "@/lib/packs/held-pack-total"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin
export const maxDuration = 30

export async function GET() {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  try {
    const { data: rows, error } = await boundedRead(sb
      .from("saved_wallets")
      .select("wallet_addr")
      .eq("user_id", user.id), "api/profile/held-pack-value/saved_wallets")
    if (error) return apiErrorResponse(error, "api/profile/held-pack-value")

    const addrs = packWalletAddresses(((rows ?? []) as Array<{ wallet_addr: string | null }>).map((r) => r.wallet_addr))
    const t = await readHeldPackTotal(sb, addrs, "api/profile/held-pack-value")
    return NextResponse.json({
      held: t.held,
      listed: t.listed,
      low_ask_usd: t.lowAskUsd,
      wallets: addrs.length,
      wallets_failed: t.walletsFailed,
    }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (err) {
    return apiErrorResponse(err, "api/profile/held-pack-value")
  }
}
