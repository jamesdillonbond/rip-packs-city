// GET /api/analytics/packs/fresh
//
// Thin wrapper over analytics_packs_fresh(p_collections, p_hours,
// p_min_price, p_max_price, p_limit). Returns recently listed pack
// drops within the requested look-back window.
//
// Query params:
//   collections  comma-separated list  (optional)
//   hours        look-back hours       (default 24, max 168)
//   min_price    ask floor in USD      (default 1)
//   max_price    ask ceiling in USD    (default 5000)
//   limit        max rows              (default 25)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"

export const dynamic = 'force-dynamic'
export const revalidate = 600

function parseHours(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : 24
  if (!Number.isFinite(n) || n <= 0) return 24
  return Math.min(168, Math.max(1, n))
}

function parseNumeric(raw: string | null, fallback: number): number {
  const n = raw ? Number(raw) : fallback
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

function parseLimit(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : 25
  if (!Number.isFinite(n) || n <= 0) return 25
  return Math.max(1, n)
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))
    const hours = parseHours(url.searchParams.get("hours"))
    const minPrice = parseNumeric(url.searchParams.get("min_price"), 1)
    const maxPrice = parseNumeric(url.searchParams.get("max_price"), 5000)
    const limit = parseLimit(url.searchParams.get("limit"))

    console.log(
      `[analytics/packs/fresh] start collections=${collections?.join(",") ?? "all"} hours=${hours} min_price=${minPrice} max_price=${maxPrice} limit=${limit}`
    )

    const { data, error } = await rpcWithRetry<unknown[]>(
      supabaseAdmin,
      "analytics_packs_fresh",
      {
        p_collections: collections,
        p_hours: hours,
        p_min_price: minPrice,
        p_max_price: maxPrice,
        p_limit: limit,
      }
    )

    if (error) {
      console.log("[analytics/packs/fresh] rpc_error", error.message)
      return NextResponse.json({ error: "packs_fresh_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as unknown[]
    console.log(
      `[analytics/packs/fresh] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
    )

    return NextResponse.json(
      { rows, hours, min_price: minPrice, max_price: maxPrice },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/packs/fresh] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "packs_fresh_failed" }, { status: 500 })
  }
}
