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

  // Enrich with acquisition_method from moment_acquisitions
  if (data && Array.isArray(data)) {
    const nftIds = data.map((r: any) => r.nft_id).filter(Boolean)
    if (nftIds.length > 0) {
      const { data: acqData } = await (supabase as any).rpc("get_wallet_acquisition_data", {
        p_wallet: normalized,
        p_moment_ids: nftIds,
      })
      if (acqData) {
        const acqMap = new Map<string, string>()
        for (const row of acqData) {
          if (!acqMap.has(row.moment_id)) acqMap.set(row.moment_id, row.acquisition_method)
        }
        for (const item of data) {
          item.acquisition_method = acqMap.get(item.nft_id) ?? null
        }
      }
    }
  }
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(
    { acquisitions: data ?? [] },
    { headers: { "Cache-Control": "private, max-age=60" } }
  )
}
