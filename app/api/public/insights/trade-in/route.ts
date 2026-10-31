// app/api/public/insights/trade-in/route.ts
//
// PUBLIC INSIGHTS — Top Shot This trade-in finder. Top Shot's Series 2026-27
// program counts every $10 of a player's Moments, at TOP SHOT'S OWN average sale
// price, as one Top Shot This pack of that player. Per edition: Top Shot's ASP,
// the lowest live ask, how many Moments reach $10, and what buying them at the ask
// costs. Backed by v_insights_trade_in (security_invoker = on, anon-granted;
// migration 20261031182000). No FMV or confidence by design — see
// lib/insights/trade-in-board.ts.
//
// Lives under /api/public/* so proxy.ts lets it through with no auth.
//
// Query params:
//   player=<text>          ilike match on player_name (the finder)
//   sort=cost|ratio|asp    default cost (cheapest pack first)
//   limit=<1..500>         default 100
//   wallet=0x…             INSTEAD of the board: the wallet's own trade-in value per
//                          player (most ASP first) AND its cheapest next pack per
//                          player (cheapest first) — get_topshot_trade_in_wallet, one scan
//
// Response: { meta: {...}, rows: [...] } or, with wallet, { meta, players: [...], next_pack: [...] }.
// CACHE: 1-hour s-maxage on the board (Top Shot's figures refresh about daily);
// the wallet arm is no-store (it is the caller's own holdings).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"
import { boardUnavailable } from "@/lib/insights/board-error"
import { boardRowMeta } from "@/lib/insights/board-meta"
import { normalizeFlowAddress } from "@/lib/address"
import {
  ASP_PER_PACK_USD,
  cleanPlayerFilter,
  fetchTradeInBoard,
  fetchTradeInWallet,
  PORTFOLIO_PLAYERS,
  TRADE_IN_SORTS,
  type TradeInRow,
  type TradeInSort,
  type TradeInWallet,
} from "@/lib/insights/trade-in-board"

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const sp = new URL(req.url).searchParams

  const walletRaw = sp.get("wallet")
  if (walletRaw != null) {
    const wallet = normalizeFlowAddress(walletRaw)
    // a malformed address is refused, never answered with an empty portfolio
    if (!wallet) return NextResponse.json({ error: "wallet must be a Flow 0x address", code: "bad_request" }, { status: 400 })
    let result
    try {
      result = await boundedRead(fetchTradeInWallet(supabase as never, wallet), "insights/trade-in wallet", 8000)
    } catch (e) {
      return boardUnavailable(e, "insights/trade-in wallet")
    }
    if (result.error || !result.data) return boardUnavailable(result.error, "insights/trade-in wallet")
    const w = result.data as TradeInWallet
    const res = NextResponse.json({
      meta: {
        fetched_at: new Date().toISOString(),
        source: "get_topshot_trade_in_wallet",
        asp_per_pack_usd: ASP_PER_PACK_USD,
        wallet: w.wallet,
        shown: w.players.length,
        total_players: w.total_players,
        players_with_fill: w.players_with_fill,
        limit: PORTFOLIO_PLAYERS,
        elapsed_ms: Date.now() - startedAt,
      },
      players: w.players,
      next_pack: w.next_pack,
    })
    res.headers.set("Cache-Control", "no-store")
    return res
  }

  const player = cleanPlayerFilter(sp.get("player"))
  const sortRaw = sp.get("sort")?.trim().toLowerCase() || "cost"
  const sort: TradeInSort = (TRADE_IN_SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as TradeInSort) : "cost"
  const limit = Math.max(1, Math.min(500, Number(sp.get("limit")) || 100))

  let result
  try {
    result = await boundedRead(fetchTradeInBoard(supabase as never, { player, sort, limit }), "insights/trade-in", 8000)
  } catch (e) {
    return boardUnavailable(e, "insights/trade-in")
  }
  if (result.error || !result.data) return boardUnavailable(result.error, "insights/trade-in")
  const rows = result.data as TradeInRow[]

  const elapsedMs = Date.now() - startedAt
  console.log(`[public/insights/trade-in] returned=${rows.length} player=${player || "-"} sort=${sort} elapsedMs=${elapsedMs}`)

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "v_insights_trade_in",
      asp_per_pack_usd: ASP_PER_PACK_USD,
      ...boardRowMeta(rows.length, limit),
      elapsed_ms: elapsedMs,
      filters: { player: player || null, sort, limit },
    },
    rows,
  })
  res.headers.set("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=300")
  return res
}
