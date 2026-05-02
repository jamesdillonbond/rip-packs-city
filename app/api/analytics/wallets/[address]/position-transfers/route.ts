// GET /api/analytics/wallets/[address]/position-transfers
//
// Thin wrapper over analytics_wallet_position_transfers(p_addr). Returns the
// RPC payload as-is. Empty/zeroed response (has_activity=false) is the
// common case — most wallets never participated in a HybridCustody
// position transfer.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { WalletPositionTransfersResponse } from "@/lib/analytics-types"

export const revalidate = 600

const FLOW_ADDR_RE = /^0x[0-9a-f]{16}$/i

interface RouteParams {
  params: Promise<{ address: string }>
}

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const t0 = Date.now()
  const { address } = await params
  const addr = (address || "").toLowerCase()
  if (!FLOW_ADDR_RE.test(addr)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 })
  }

  try {
    const { data, error } = await rpcWithRetry<WalletPositionTransfersResponse>(
      supabaseAdmin,
      "analytics_wallet_position_transfers",
      { p_addr: addr }
    )
    if (error) {
      console.log("[wallets/position-transfers] rpc_error", error.message)
      return NextResponse.json({ error: "position_transfers_failed" }, { status: 500 })
    }

    console.log(
      `[wallets/position-transfers] ok addr=${addr} elapsed=${Date.now() - t0}ms has_activity=${data?.has_activity ?? false}`
    )

    return NextResponse.json(data ?? null, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
      },
    })
  } catch (e: any) {
    console.log("[wallets/position-transfers] error", e?.message || e)
    return NextResponse.json({ error: "position_transfers_failed" }, { status: 500 })
  }
}
