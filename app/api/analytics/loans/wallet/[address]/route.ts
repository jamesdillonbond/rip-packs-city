// GET /api/analytics/loans/wallet/[address]
//
// Thin wrapper over flowty_analytics_wallet_detail(p_addr). Returns the
// jsonb payload verbatim. Validates the address format (Flow: 0x +
// 16 hex chars = 18 chars total) before hitting the RPC and returns 404
// for unknown / inactive addresses (the RPC returns NULL in that case).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { WalletDetailResponse } from "@/lib/analytics-types"

export const revalidate = 600

const FLOW_ADDR_RE = /^0x[0-9a-f]{16}$/i

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ address: string }> }
) {
  const t0 = Date.now()
  try {
    const { address } = await ctx.params
    const addr = (address || "").toLowerCase()
    if (!FLOW_ADDR_RE.test(addr)) {
      return NextResponse.json({ error: "invalid_address" }, { status: 400 })
    }

    console.log(`[analytics/loans/wallet] start addr=${addr}`)

    const { data, error } = await rpcWithRetry<WalletDetailResponse>(
      supabaseAdmin,
      "flowty_analytics_wallet_detail",
      { p_addr: addr }
    )

    if (error) {
      console.log("[analytics/loans/wallet] rpc_error", error.message)
      return NextResponse.json({ error: "wallet_failed" }, { status: 500 })
    }

    if (!data) {
      console.log(`[analytics/loans/wallet] not_found addr=${addr} elapsed=${Date.now() - t0}ms`)
      return NextResponse.json({ error: "not_found" }, { status: 404 })
    }

    console.log(`[analytics/loans/wallet] ok addr=${addr} elapsed=${Date.now() - t0}ms`)

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=3600",
      },
    })
  } catch (e: any) {
    console.log("[analytics/loans/wallet] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "wallet_failed" }, { status: 500 })
  }
}
