// app/api/public/insights/underpriced-serials/route.ts
//
// PUBLIC INSIGHTS — Underpriced #1s & Perfect Mints. Top Shot serials that are
// LISTED RIGHT NOW below their serial-FMV estimate — specifically the headline
// serials collectors chase: the #1 mint and the perfect mint (#N/N). Each row is
// a live, buyable deal, not a historical sale.
//
// Backed by topshot_underpriced_serials_board (see lib/underpriced-serials-board.ts):
//   listings spine  = topshot_active_listings (GitHub-Actions curl ingest of the
//                     public Dapper Atlas API; Atlas WAF-blocks Vercel egress)
//   estimate        = serial_fmv_estimate (same engine the moment page uses)
// The board reads the estimate live; this cache just bounds load.
//
// estimate_quality is the honesty axis: `tight` rows have a trustworthy discount
// magnitude; `coarse` rows (a COMMON #1 on a big common) use a player-blind
// population multiplier, so the % is directional. Both are returned; the UI leads
// with tight and frames coarse as an estimate.
//
// Lives under /api/public/* so the proxy.ts allowlist lets it through with no auth.
//
// Query params:
//   headline=all|no1|perfect                      default all
//   quality=all|tight|coarse                      default all
//   tier=COMMON|RARE|FANDOM|LEGENDARY|ULTIMATE     (400 on invalid)
//   min_discount=<number>    filter discount_pct;  default 0
//   sort=discount|ask|recent                       default discount
//   limit=<1..100>           default 100
//
// Response: { meta: { fetched_at, source, total_rows, elapsed_ms, filters }, rows: [...] }
//
// CACHE: 15-min s-maxage (the board is live; this bounds a viral OG-share spike).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import {
  fetchUnderpricedSerials,
  parseHeadlineMode,
  parseQuality,
  parseSort,
} from "@/lib/underpriced-serials-board"

const VALID_TIERS = new Set(["COMMON", "RARE", "FANDOM", "LEGENDARY", "ULTIMATE"])
const SOURCE = "topshot_underpriced_serials_board"

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const sp = new URL(req.url).searchParams

  const headline = parseHeadlineMode(sp.get("headline"))
  const quality = parseQuality(sp.get("quality"))

  const tier = sp.get("tier")?.trim().toUpperCase() || null
  if (tier && !VALID_TIERS.has(tier)) {
    return NextResponse.json(
      { error: `tier must be one of ${[...VALID_TIERS].join(",")}` },
      { status: 400 }
    )
  }

  const minDiscountRaw = Number(sp.get("min_discount") ?? "0")
  const minDiscount = Number.isFinite(minDiscountRaw) && minDiscountRaw > 0 ? minDiscountRaw : 0

  const sort = parseSort(sp.get("sort"))
  const limit = Math.max(1, Math.min(100, Number(sp.get("limit") ?? "100")))

  let rows
  try {
    rows = await fetchUnderpricedSerials(supabase, { headline, tier, quality, minDiscount, sort, limit })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[public/insights/underpriced-serials]", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  const elapsedMs = Date.now() - startedAt
  console.log(
    `[public/insights/underpriced-serials] headline=${headline} quality=${quality} returned=${rows.length} tier=${tier ?? "*"} min=${minDiscount} sort=${sort} elapsedMs=${elapsedMs}`
  )

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: SOURCE,
      total_rows: rows.length,
      elapsed_ms: elapsedMs,
      filters: { headline, quality, tier, min_discount: minDiscount, sort, limit },
    },
    rows,
  })

  res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=300")
  return res
}
