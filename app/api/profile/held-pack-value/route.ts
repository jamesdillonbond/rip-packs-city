// app/api/profile/held-pack-value/route.ts
//
// GET /api/profile/held-pack-value
//
// Sealed packs held across EVERY wallet saved on the signed-in account, valued at
// the lowest live ask — shown beside the aggregated wallet value on /dashboard
// (Trevor, 2026-11-21). Wraps wallet_held_pack_value(p_wallet) once per distinct
// saved Flow address, in parallel. Measured 2026-11-21: 0.2–3.1 s per wallet
// (327 held packs → 0.56 s). A wallet whose read fails is counted in
// `wallets_failed`, never folded in as $0.
//
// Auth: Supabase user session. Takes no wallet parameter — the addresses come
// from the caller's own saved_wallets, so there is nothing to spoof.

import { NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { supabaseAdmin } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"
import { isCadenceAddress, normalizeAddress } from "@/lib/address"
import { sumHeldPacks, type HeldPackValueRow } from "@/lib/dashboard/held-packs"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

// wallet_held_pack_value carries its own 20 s statement_timeout; wait just past it
// so a genuinely stuck read is reported as failed rather than hanging the tile.
const READ_BUDGET_MS = 21_000
// Cap the fan-out; one RPC account holds one Dapper wallet (2026-11-07 rule),
// older accounts a handful.
const MAX_WALLETS = 12
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

    // Packs are Flow assets (Top Shot, All Day, Pinnacle, Golazos); a Solana or
    // Aptos address cannot hold one, so it is not read.
    const addrs = Array.from(new Set(
      ((rows ?? []) as Array<{ wallet_addr: string | null }>)
        .map((r) => normalizeAddress(r.wallet_addr ?? ""))
        .filter((a) => a && isCadenceAddress(a)),
    )).slice(0, MAX_WALLETS)

    const answers = await Promise.all(addrs.map(async (addr): Promise<HeldPackValueRow | null> => {
      try {
        const { data, error: e } = await boundedRead(
          sb.rpc("wallet_held_pack_value", { p_wallet: addr }),
          "api/profile/held-pack-value/wallet_held_pack_value",
          READ_BUDGET_MS,
        )
        if (e || !data || typeof data !== "object" || "error" in data) return null
        return data as HeldPackValueRow
      } catch {
        return null
      }
    }))

    const t = sumHeldPacks(answers)
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
