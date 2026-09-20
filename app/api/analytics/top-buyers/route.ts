// GET /api/analytics/top-buyers
//
// Thin wrapper over get_top_accumulators(p_collection_slug, p_days, p_limit) —
// the buyer-side accumulation leaderboard ("who is sweeping what"). Returns the
// RPC rows enriched with:
//   - username             resolved @handle for the buyer (falls back to trunc)
//   - top_edition_player / top_edition_set   display name of the swept edition
//
// Lit up by the 2026-06-09 buyer-resolution ship (b7211fb): Top Shot sales now
// carry buyer_address on ~100% of post-deploy sales, so this surface is
// meaningful for the last ~48h. Buyer coverage over the full 30d is still low
// (backfill draining), so the client defaults to the 7d window where the data
// actually lives.
//
// Query params:
//   collection  long-form slug (nba_top_shot, …)   (default nba_top_shot)
//   days        7 | 30                               (default 7)
//   limit       1..50                                (default 25)
//
// get_top_accumulators is service_role-only → called via supabaseAdmin.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import { resolveUsernames, displayName } from "@/lib/flowty-username"

export const dynamic = "force-dynamic"
export const revalidate = 600

interface AccumulatorRow {
  rank: number
  buyer_address: string
  buy_count: number
  spend_usd: number
  avg_price_usd: number
  distinct_editions: number
  top_edition_id: string | null
  top_edition_buys: number
}

// Long-form collection slugs (collections.slug) `get_top_accumulators` can
// serve. It reads `sales` JOIN `collections`, so a collection is in this set
// exactly when its sales live in `sales`.
//
// ⛔ `disney_pinnacle` IS DELIBERATELY ABSENT and that is not an oversight:
// Pinnacle's sales are in `pinnacle_sales`, a separate table this RPC does not
// read (which is why `analytics_sales_summary` carries its own union arm for it).
// Asking for it would return zero rows, and the caller renders zero rows as
// "no buyer-resolved accumulation" — a FALSE claim about a collection with 240
// distinct buyers in 30d. Serving it needs a Pinnacle arm in the RPC, not an
// entry here.
//
// ⚠ `candy_mlb` added 2026-09-20. Measured that day, buyer_address coverage over
// 30d: candy_mlb 100% (1,549 sales / 95 buyers) · laliga_golazos 100% · 
// nfl_all_day 99.8% · nba_top_shot 95.2%. **Every figure here is a dated sample.**
const ALLOWED_COLLECTIONS = new Set([
  "nba_top_shot",
  "nfl_all_day",
  "laliga_golazos",
  "ufc_strike",
  "candy_mlb",
])

function parseDays(raw: string | null): number {
  return parseInt(raw || "7", 10) === 30 ? 30 : 7
}

function parseLimit(raw: string | null): number {
  const n = parseInt(raw || "25", 10)
  if (!Number.isFinite(n) || n <= 0) return 25
  return Math.min(50, n)
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collectionRaw = (url.searchParams.get("collection") || "nba_top_shot").toLowerCase()
    // ⛔ WAS a silent fallback to nba_top_shot. Asking for one collection and
    // being handed another's buyers — under a heading naming the one you asked
    // for — is the honesty defect, not a lenient default. An ABSENT param still
    // defaults (that is a real default); an UNRECOGNISED one now says so.
    if (!ALLOWED_COLLECTIONS.has(collectionRaw)) {
      return NextResponse.json(
        {
          error: "unsupported_collection",
          message: `top-buyers has no buyer data for "${collectionRaw}". Supported: ${[...ALLOWED_COLLECTIONS].join(", ")}.`,
        },
        { status: 400 }
      )
    }
    const collection = collectionRaw
    const days = parseDays(url.searchParams.get("days"))
    const limit = parseLimit(url.searchParams.get("limit"))

    const { data, error } = await rpcWithRetry<AccumulatorRow[]>(
      supabaseAdmin,
      "get_top_accumulators",
      { p_collection_slug: collection, p_days: days, p_limit: limit }
    )

    if (error) {
      console.log("[analytics/top-buyers] rpc_error", error.message)
      return NextResponse.json({ error: "top_buyers_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as AccumulatorRow[]

    // Resolve the swept-edition UUIDs → player/set for display. sales.edition_id
    // is a FK to editions.id (uuid); the RPC returns it as text.
    const edIds = Array.from(
      new Set(rows.map((r) => r.top_edition_id).filter(Boolean))
    ) as string[]
    const edMap = new Map<string, { player: string | null; set: string | null }>()
    if (edIds.length > 0) {
      const { data: eds } = await supabaseAdmin
        .from("editions")
        .select("id, player_name, set_name")
        .in("id", edIds)
      for (const e of (eds ?? []) as Array<{
        id: string
        player_name: string | null
        set_name: string | null
      }>) {
        edMap.set(e.id, { player: e.player_name, set: e.set_name })
      }
    }

    const names = await resolveUsernames(rows.map((r) => r.buyer_address))
    const enriched = rows.map((r) => {
      const ed = r.top_edition_id ? edMap.get(r.top_edition_id) : undefined
      return {
        ...r,
        username: displayName(r.buyer_address, names),
        top_edition_player: ed?.player ?? null,
        top_edition_set: ed?.set ?? null,
      }
    })

    console.log(
      `[analytics/top-buyers] ok elapsed=${Date.now() - t0}ms rows=${enriched.length} collection=${collection} days=${days}`
    )

    return NextResponse.json(
      { collection, days, rows: enriched },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/top-buyers] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "top_buyers_failed" }, { status: 500 })
  }
}
