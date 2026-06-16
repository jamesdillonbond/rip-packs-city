// app/api/public/insights/serial-premiums/route.ts
//
// PUBLIC INSIGHTS — Serial Premiums. The most extreme real headline-serial
// premiums on Top Shot: the multiple the headline serial commanded over its
// edition's typical price (e.g. a $7.50 Jokić common whose #1 sold for $9,000 =
// 1,200×).
//
// Two boards behind one `headline` toggle (see lib/serial-premiums-board.ts):
//   headline=no1      (default) → topshot_serial_premiums_board       — the #1 mint
//   headline=perfect            → topshot_perfect_mint_premiums_board — the #N/N mint
// Both views are security_invoker=on, anon-granted, premium_multiple >= 5, and
// read sales+editions live (always current); the cache below just bounds load.
//
// Read-only JSON endpoint backing /insights/serial-premiums. Lives under
// /api/public/* so the proxy.ts allowlist lets it through with no auth.
//
// Every row is a REAL sale, not an estimate — the intelligence nbatopshot.com
// has no equivalent of, and a strong long-tail SEO surface.
//
// Query params:
//   headline=no1|perfect                          default no1
//   tier=COMMON|RARE|FANDOM|LEGENDARY|ULTIMATE     (400 on invalid)
//   min_premium=<number>     filter premium_multiple; default 5
//   window=7d|30d|90d        filter the headline sold_at; default 90d
//   sort=premium|headline_price|recent            default premium (no1_price accepted as alias)
//   limit=<1..100>           default 100
//
// Response: { meta: { fetched_at, source, headline, total_rows, elapsed_ms, filters }, rows: [...] }
//   rows are normalized to headline_serial / headline_last_sale_usd / headline_sold_at.
//
// CACHE: 15-min s-maxage (the views are live; this bounds a viral OG-share spike).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import {
  BOARDS,
  fetchSerialPremiums,
  parseHeadlineMode,
  type SerialSortKey,
} from "@/lib/serial-premiums-board"

const VALID_TIERS = new Set(["COMMON", "RARE", "FANDOM", "LEGENDARY", "ULTIMATE"])
const WINDOW_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 }

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const sp = new URL(req.url).searchParams

  const headline = parseHeadlineMode(sp.get("headline"))

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

  // `no1_price` kept as a backward-compat alias for the renamed `headline_price`.
  const sortRaw = sp.get("sort")?.trim().toLowerCase() || "premium"
  const sortKey = sortRaw === "no1_price" ? "headline_price" : sortRaw
  const sort: SerialSortKey = (["premium", "headline_price", "recent"].includes(sortKey)
    ? sortKey
    : "premium") as SerialSortKey

  const limit = Math.max(1, Math.min(100, Number(sp.get("limit") ?? "100")))

  let rows
  try {
    rows = await fetchSerialPremiums(supabase, { mode: headline, tier, windowDays, minPremium, sort, limit })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[public/insights/serial-premiums]", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  const elapsedMs = Date.now() - startedAt
  console.log(
    `[public/insights/serial-premiums] headline=${headline} returned=${rows.length} tier=${tier ?? "*"} window=${windowKey} min=${minPremium} sort=${sort} elapsedMs=${elapsedMs}`
  )

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: BOARDS[headline].table,
      headline,
      total_rows: rows.length,
      elapsed_ms: elapsedMs,
      filters: { headline, tier, window: windowKey, min_premium: minPremium, sort, limit },
    },
    rows,
  })

  res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=300")
  return res
}
