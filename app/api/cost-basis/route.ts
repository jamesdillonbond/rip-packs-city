// app/api/cost-basis/route.ts
//
// GET /api/cost-basis?wallet=0x...
// Returns per-moment cost basis for a wallet via get_wallet_cost_basis() RPC.
// Bypasses PostgREST 1000-row cap.

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim()
  if (!wallet) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const normalized = wallet.startsWith("0x") ? wallet : "0x" + wallet

  const { data, error } = await (supabase as any).rpc("get_wallet_cost_basis", { p_wallet: normalized })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(
    { acquisitions: data ?? [] },
    { headers: { "Cache-Control": "private, max-age=60" } }
  )
}
