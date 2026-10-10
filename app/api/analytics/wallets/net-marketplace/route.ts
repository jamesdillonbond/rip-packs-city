// GET /api/analytics/wallets/net-marketplace
//
// Thin wrapper over flowty_top_net_marketplace(p_collection, p_start, p_end,
// p_limit). Wallets ranked by combined buy + sell activity on Flowty's
// NFTStorefrontV2 fork. net_position_usd = sell_volume - buy_volume (that is
// what the SQL computes: COALESCE(sells) - COALESCE(buys)); the dashboard
// renders positive net = net seller (green) and negative net = net buyer (red).
// ⚠ Until 2026-10-10 this header and the component had the sign backwards
// (#178): a net seller was coloured red with a leading "+".
//
// 2026-10-10 (#178): the window is anchored to Flowty's LAST marketplace sale
// (lib/market-closed.ts FLOWTY_MARKETPLACE_CLOSED_ON), not to now(). Flowty went
// dormant on 2026-05-14, so a window measured from today was empty by
// construction; the panel lives on a page that calls itself a frozen archive,
// and "Flowty's final N days" is the honest reading of that archive. The
// response carries `as_of` (the anchor) and `archived: true` so the client can
// say so.
//
// Query params:
//   collection  topshot|allday|golazos|pinnacle|ufc|all  (default 'all')
//   days        1..365 (ending at the close date)         (default 30)
//   limit       1..50                                     (default 15)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { NetMarketplaceRow, NetMarketplaceResponse } from "@/lib/analytics-types"
import { FLOWTY_MARKETPLACE_CLOSED_ON } from "@/lib/market-closed"

export const dynamic = 'force-dynamic'
export const revalidate = 300

const ALLOWED_COLLECTIONS = new Set(["topshot", "allday", "golazos", "pinnacle", "ufc", "all"])
const DAY_MS = 24 * 60 * 60 * 1000

// An ABSENT collection means all collections. A PRESENT unknown one returns
// null and is refused: answering "?collection=candy" with every collection's
// wallets is substitution, the honesty face where nothing fails (2026-10-09).
function parseCollection(raw: string | null): string | null {
  if (raw == null || raw.trim() === "") return "all"
  const lower = raw.trim().toLowerCase()
  return ALLOWED_COLLECTIONS.has(lower) ? lower : null
}

function parseInt1(raw: string | null, def: number, min: number, max: number): number {
  const n = parseInt(raw || "", 10)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, n))
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collection = parseCollection(url.searchParams.get("collection"))
    if (collection == null) {
      return NextResponse.json({ error: "unsupported_collection" }, { status: 400 })
    }
    const days = parseInt1(url.searchParams.get("days"), 30, 1, 365)
    const limit = parseInt1(url.searchParams.get("limit"), 15, 1, 50)

    // The archive's last day, inclusive: windows run back from the end of the
    // day Flowty's marketplace went dormant.
    const end = new Date(`${FLOWTY_MARKETPLACE_CLOSED_ON}T23:59:59.999Z`)
    const start = new Date(end.getTime() - days * DAY_MS)

    console.log(
      `[analytics/wallets/net-marketplace] start collection=${collection} days=${days} limit=${limit}`
    )

    const { data, error } = await rpcWithRetry<NetMarketplaceRow[]>(
      supabaseAdmin,
      "flowty_top_net_marketplace",
      {
        p_collection: collection,
        p_start: start.toISOString(),
        p_end: end.toISOString(),
        p_limit: limit,
      }
    )

    if (error) {
      console.log("[analytics/wallets/net-marketplace] rpc_error", error.message)
      return NextResponse.json({ error: "net_marketplace_failed" }, { status: 500 })
    }

    const rows = ((data ?? []) as NetMarketplaceRow[]).map((r) => ({
      ...r,
      buy_volume_usd: Number(r.buy_volume_usd) || 0,
      sell_volume_usd: Number(r.sell_volume_usd) || 0,
      gross_activity_usd: Number(r.gross_activity_usd) || 0,
      net_position_usd: Number(r.net_position_usd) || 0,
      buy_tx_count: Number(r.buy_tx_count) || 0,
      sell_tx_count: Number(r.sell_tx_count) || 0,
      total_tx_count: Number(r.total_tx_count) || 0,
    }))

    const payload: NetMarketplaceResponse = { collection, days, as_of: FLOWTY_MARKETPLACE_CLOSED_ON, archived: true, rows }
    console.log(
      `[analytics/wallets/net-marketplace] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
    )

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
      },
    })
  } catch (e: any) {
    console.log("[analytics/wallets/net-marketplace] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "net_marketplace_failed" }, { status: 500 })
  }
}
