// app/api/public/insights/market-pulse/route.ts
//
// PUBLIC INSIGHTS — Market Pulse. Per-collection secondary-market health across
// 24h / 7d / 30d (volume, sales, buyers, sellers, top sale) for all 5 published
// collections in ONE view. Dapper/Top Shot only show one league at a time.
//
// Backed by get_market_pulse_windows() (SECDEF, service_role) called with the
// admin client. Under /api/public/* so proxy.ts lets it through. CACHE 5-min.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { fetchMarketPulse } from "@/lib/market-pulse-board"

export async function GET() {
  try {
    const rows = await fetchMarketPulse(supabaseAdmin)
    const res = NextResponse.json({ meta: { fetched_at: new Date().toISOString(), source: "get_market_pulse_windows" }, rows })
    res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=120")
    return res
  } catch (e) {
    return boardUnavailable(e, "market-pulse")
  }
}
