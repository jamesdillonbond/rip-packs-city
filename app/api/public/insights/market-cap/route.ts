// app/api/public/insights/market-cap/route.ts
//
// PUBLIC INSIGHTS — Market Cap. FMV x collector-held supply (minted - burned -
// issuer-held) at collection / edition / player / team / set / series / tier / badge
// grain. Backs /insights/market-cap. Under /api/public/* so proxy.ts lets anon through.
//
//   GET ?group=<grain>&collection=<url-or-db slug>&limit=<1..500>
//
// The page and this route both call fetchMarketCapBoard, so they never diverge.
// get_market_cap_board is SECURITY DEFINER and service_role-only; it carries no
// wallet data.
//
// ⚠ An UNKNOWN collection or group is REFUSED (400) — never answered with another
// collection's numbers or a default grain. Only an ABSENT param defaults.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  METHOD_NOTE,
  fetchMarketCapBoard,
  isMarketCapGroup,
  resolveCollectionParam,
} from "@/lib/insights/market-cap-board"

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const groupParam = sp.get("group")
  const group = groupParam == null || groupParam === "" ? "collection" : groupParam
  if (!isMarketCapGroup(group)) {
    return NextResponse.json({ error: "unknown group" }, { status: 400 })
  }
  const collection = resolveCollectionParam(sp.get("collection"))
  if (collection === undefined) {
    return NextResponse.json({ error: "unknown collection" }, { status: 400 })
  }
  // NaN-safe: `?limit=abc` falls back to the default rather than reaching the RPC as NaN.
  const limit = Math.min(Math.max(Math.trunc(Number(sp.get("limit")) || DEFAULT_LIMIT), 1), MAX_LIMIT)

  const startedAt = Date.now()
  try {
    const board = await fetchMarketCapBoard(supabase, group, collection, limit)
    const elapsedMs = Date.now() - startedAt
    console.log(`[public/insights/market-cap] group=${group} collection=${collection ?? "all"} rows=${board.rows.length} elapsedMs=${elapsedMs}`)
    const res = NextResponse.json({
      meta: {
        fetched_at: new Date().toISOString(),
        source: "get_market_cap_board",
        group,
        collection,
        limit,
        elapsed_ms: elapsedMs,
        method_note: METHOD_NOTE,
      },
      rows: board.rows,
    })
    // FMV and Atlas supply move on hourly-ish cadences; 15 minutes bounds a share spike.
    res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=1800")
    return res
  } catch (e) {
    return boardUnavailable(e, "insights/market-cap")
  }
}
