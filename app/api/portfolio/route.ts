// app/api/portfolio/route.ts
// GET /api/portfolio?wallet=0x... — cross-collection portfolio breakdown.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim().toLowerCase()
  if (!wallet) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }

  try {
    const { data, error } = await boundedRead((supabaseAdmin as any).rpc(
      "get_cross_collection_portfolio",
      { p_wallet: wallet }
    ), "api/portfolio/get_cross_collection_portfolio")
    if (error) {
      return apiErrorResponse(error, "api/portfolio");
    }
    return NextResponse.json(data ?? {}, {
      headers: { "Cache-Control": "public, max-age=0, s-maxage=120" },
    })
  } catch (err) {
    return apiErrorResponse(err, "api/portfolio");
  }
}
