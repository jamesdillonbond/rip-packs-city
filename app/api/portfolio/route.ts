// app/api/portfolio/route.ts
// GET /api/portfolio?wallet=0x... — cross-collection portfolio breakdown.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim().toLowerCase()
  if (!wallet) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }

  try {
    const { data, error } = await (supabaseAdmin as any).rpc(
      "get_cross_collection_portfolio",
      { p_wallet: wallet }
    )
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json(data ?? {}, {
      headers: { "Cache-Control": "public, max-age=0, s-maxage=120" },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
