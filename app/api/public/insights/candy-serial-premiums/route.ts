// app/api/public/insights/candy-serial-premiums/route.ts
//
// PUBLIC INSIGHTS — Candy Serial Premiums (2026-11-23, Candy parity pass 1): every #1, jersey-match and perfect-serial
// sale with the premium it earned over the same card's other serials. JSON twin of /insights/candy-serial-premiums;
// the read lives in lib/insights/candy-parity-boards.ts. A failed read is boardUnavailable, never an empty board.
//
// CACHE: 30-min s-maxage (special-serial sales are a few a week).

import { NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { fetchCandySerialPremiums } from "@/lib/insights/candy-parity-boards"

export async function GET() {
  const startedAt = Date.now()
  let payload
  try {
    payload = await withBoardBudget(fetchCandySerialPremiums(supabase), "candy-serial-premiums")
  } catch (e) {
    return boardUnavailable(e, "insights/candy-serial-premiums")
  }
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "get_candy_serial_premiums",
      elapsed_ms: Date.now() - startedAt,
      stats: payload.stats,
      rows: payload.rows.length,
    },
    rows: payload.rows,
  })
  res.headers.set("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=300")
  return res
}
