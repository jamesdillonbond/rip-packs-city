// app/api/public/insights/serial-premiums/route.ts
//
// PUBLIC INSIGHTS — Serial Premiums (#1 Watch). The most extreme real #1-mint
// premiums on Top Shot: the multiple the #1 serial commanded over its edition's
// typical price (e.g. a $7.50 Jokić common whose #1 sold for $9,000 = 1,200×).
//
// Read-only JSON endpoint backing /insights/serial-premiums. Lives under
// /api/public/* so the proxy.ts allowlist lets it through with no auth. Reads
// the public `topshot_serial_premiums_board` view (Cowork
// audit_20260616_topshot_serial_premiums_board, security_invoker=on, granted
// anon) — one row per canonical TS edition with a recent #1 sale, premium ≥ 5×.
// The view reads sales+editions live (no materialization), so it is always
// current; the cache below just bounds load.
//
// Every row is a REAL sale, not an estimate — the intelligence nbatopshot.com
// has no equivalent of, and a strong long-tail SEO surface.
//
// Query params:
//   tier=COMMON|RARE|FANDOM|LEGENDARY|ULTIMATE   (400 on invalid)
//   min_premium=<number>     filter premium_multiple; default 5
//   window=7d|30d|90d        filter no1_sold_at; default 90d
//   sort=premium|no1_price|recent                default premium
//   limit=<1..100>           default 100
//
// Response: { meta: { fetched_at, source, total_rows, elapsed_ms, filters }, rows: [...] }
//
// CACHE: 15-min s-maxage (the view is live; this bounds a viral OG-share spike).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const VALID_TIERS = new Set(["COMMON", "RARE", "FANDOM", "LEGENDARY", "ULTIMATE"])
const WINDOW_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 }

const SELECT_COLS =
  "edition_id, external_id, player_name, set_name, tier, circulation_count, thumbnail_url, moment_id, nft_id, edition_median_usd, no1_last_sale_usd, premium_multiple, no1_sold_at, edition_sales_180d"

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const sp = new URL(req.url).searchParams

  const tier = sp.get("tier")?.trim().toUpperCase() || null
  if (tier && !VALID_TIERS.has(tier)) {
    return NextResponse.json(
      { error: `tier must be one of ${[...VALID_TIERS].join(",")}` },
      { status: 400 }
    )
  }

  const windowKey = WINDOW_DAYS[sp.get("window") ?? ""] ? (sp.get("window") as string) : "90d"
  const windowDays = WINDOW_DAYS[windowKey]

  const minPremiumRaw = Number(sp.get("min_premium") ?? "5")
  const minPremium = Number.isFinite(minPremiumRaw) && minPremiumRaw > 0 ? minPremiumRaw : 5

  const sortKey = sp.get("sort")?.trim().toLowerCase() || "premium"
  const sort = ["premium", "no1_price", "recent"].includes(sortKey) ? sortKey : "premium"

  const limit = Math.max(1, Math.min(100, Number(sp.get("limit") ?? "100")))

  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()

  let q = (supabase as any)
    .from("topshot_serial_premiums_board")
    .select(SELECT_COLS)
    .gte("premium_multiple", minPremium)
    .gte("no1_sold_at", sinceIso)

  if (tier) q = q.eq("tier", tier)

  if (sort === "no1_price") q = q.order("no1_last_sale_usd", { ascending: false })
  else if (sort === "recent") q = q.order("no1_sold_at", { ascending: false })
  else q = q.order("premium_multiple", { ascending: false })

  q = q.limit(limit)

  const { data, error } = await q
  if (error) {
    console.error("[public/insights/serial-premiums]", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = data ?? []
  const elapsedMs = Date.now() - startedAt
  console.log(
    `[public/insights/serial-premiums] returned=${rows.length} tier=${tier ?? "*"} window=${windowKey} min=${minPremium} sort=${sort} elapsedMs=${elapsedMs}`
  )

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "topshot_serial_premiums_board",
      total_rows: rows.length,
      elapsed_ms: elapsedMs,
      filters: { tier, window: windowKey, min_premium: minPremium, sort, limit },
    },
    rows,
  })

  res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=300")
  return res
}
