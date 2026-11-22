// app/api/public/wallet-packs/route.ts
//
// GET /api/public/wallet-packs?wallet=0x… — public, no auth.
//
// Sealed packs one Flow wallet holds, at the lowest live ask — shown under the
// Total Collection FMV on /share/<wallet> (Trevor, 2026-11-21: "show the pack low
// ask total, when showing the aggregated wallet value"). Same public, wallet-keyed
// shape as /api/public/wallet-intel; everything here is public on-chain data.
// Totals only. The CDN and the share page's fetch cache hold each answer 10 min.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { supabaseAdmin } from "@/lib/supabase"
import { packWalletAddresses, readHeldPackTotal } from "@/lib/packs/held-pack-total"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin
export const maxDuration = 30

const FLOW_ADDR = /^0x[0-9a-fA-F]{16}$/

export async function GET(req: NextRequest) {
  const wallet = (req.nextUrl.searchParams.get("wallet") ?? "").trim()
  if (!FLOW_ADDR.test(wallet)) {
    return NextResponse.json(
      { error: "wallet query param must be a 0x-prefixed 16-hex Flow address" },
      { status: 400 },
    )
  }
  try {
    const t = await readHeldPackTotal(sb, packWalletAddresses([wallet]), "api/public/wallet-packs")
    if (t.walletsFailed > 0) {
      // Never a $0 answer for a read that did not happen.
      return NextResponse.json({ error: "pack value unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } })
    }
    return NextResponse.json(
      { held: t.held, listed: t.listed, low_ask_usd: t.lowAskUsd },
      { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600" } },
    )
  } catch (err) {
    return apiErrorResponse(err, "api/public/wallet-packs")
  }
}
