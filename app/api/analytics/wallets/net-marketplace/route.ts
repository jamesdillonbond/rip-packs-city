// GET /api/analytics/wallets/net-marketplace
//
// Thin wrapper over flowty_top_net_marketplace(p_collection, p_start, p_end,
// p_limit). Wallets ranked by combined buy + sell activity on Flowty's
// NFTStorefrontV2 fork. net_position_usd = buy_volume - sell_volume; the
// dashboard renders negative net = net seller (green) and positive net =
// net buyer (red).
//
// Query params:
//   collection  topshot|allday|golazos|pinnacle|ufc|all  (default 'all')
//   days        1..365                                    (default 30)
//   limit       1..50                                     (default 15)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { NetMarketplaceRow, NetMarketplaceResponse } from "@/lib/analytics-types"

export const revalidate = 300

const ALLOWED_COLLECTIONS = new Set(["topshot", "allday", "golazos", "pinnacle", "ufc", "all"])
const DAY_MS = 24 * 60 * 60 * 1000

function parseCollection(raw: string | null): string {
  if (!raw) return "all"
  const lower = raw.trim().toLowerCase()
  return ALLOWED_COLLECTIONS.has(lower) ? lower : "all"
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
    const days = parseInt1(url.searchParams.get("days"), 30, 1, 365)
    const limit = parseInt1(url.searchParams.get("limit"), 15, 1, 50)

    const now = new Date()
    const start = new Date(now.getTime() - days * DAY_MS)

    console.log(
      `[analytics/wallets/net-marketplace] start collection=${collection} days=${days} limit=${limit}`
    )

    const { data, error } = await rpcWithRetry<NetMarketplaceRow[]>(
      supabaseAdmin,
      "flowty_top_net_marketplace",
      {
        p_collection: collection,
        p_start: start.toISOString(),
        p_end: now.toISOString(),
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

    const payload: NetMarketplaceResponse = { collection, days, rows }
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
