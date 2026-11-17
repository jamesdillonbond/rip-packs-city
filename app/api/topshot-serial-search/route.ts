// app/api/topshot-serial-search/route.ts
//
// GET /api/topshot-serial-search?serial=23[&maxPrice=50][&tier=rare]
// Feedback #12359: every listed Top Shot Moment with serial #N, across all editions.
//
// ⚠ NOT a Sniper post-filter. The Sniper's Top Shot pool is the newest 200 rows of
// ts_listings, and ts_listings is the Atlas 24 h CHANGE window, not the book — so a
// filter over it answers "none" for serials outside the page. This reads every open
// Atlas listing row for the serial through get_topshot_listings_by_serial and passes
// its per-row confirmation class and its COVERAGE through unchanged:
//   confirmed_24h      seen in the last 24 h
//   confirmed_verified on an edition whose complete listing book was read ≤ 7 d ago,
//                      and re-seen at that read
//   unconfirmed        listed when last seen, not re-checked recently — may have sold
//
// THREE states (CLAUDE.md "Honesty"): a failed read is a 5xx, never `rows: []`
// (lib/sniper/source-failures.ts's contract); a read that found nothing returns
// coverage with a measured 0; rows render. Read-only — the UI links out to the
// listing, it never buys.

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"

const TIERS = ["COMMON", "FANDOM", "RARE", "LEGENDARY", "ULTIMATE"] as const

const querySchema = z.object({
  serial: z.coerce.number().int().min(1).max(99_999),
  maxPrice: z.coerce.number().positive().max(10_000_000).optional(),
  tier: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.enum(TIERS))
    .optional(),
})

const ROW_LIMIT = 500

export type SerialSearchRow = {
  nft_id: string
  listing_resource_id: string | null
  price_usd: number
  serial_number: number
  confirmation: "confirmed_24h" | "confirmed_verified" | "unconfirmed"
  listed_at: string | null
  last_seen_at: string | null
  book_verified_at: string | null
  edition_id: string | null
  external_id: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  parallel: string | null
  circulation_count: number | null
  fmv_usd: number | null
}

export type SerialSearchCoverage = {
  serial: number
  confirmed_count: number
  confirmed_24h: number
  confirmed_verified: number
  unconfirmed_count: number
  editions_with_listing: number
  editions_verified_7d: number
  returned_confirmed: number
  returned_unconfirmed: number
  window_hours: number
  verify_days: number
  lookback_days: number
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const raw: Record<string, string> = {}
  for (const k of ["serial", "maxPrice", "tier"]) {
    const v = sp.get(k)
    if (v != null && v.trim() !== "" && !(k === "tier" && v.trim().toLowerCase() === "all")) raw[k] = v
  }
  const parsed = querySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "serial must be a whole number from 1 to 99,999; maxPrice a positive number; tier a Top Shot tier" },
      { status: 400 },
    )
  }
  const { serial, maxPrice, tier } = parsed.data

  try {
    const { data, error } = await boundedRead(
      (supabaseAdmin as any).rpc("get_topshot_listings_by_serial", {
        p_serial: serial,
        p_max_price_usd: maxPrice ?? null,
        p_tier: tier ?? null,
        p_limit: ROW_LIMIT,
      }),
      "api/topshot-serial-search",
    )
    if (error) throw new Error(error.message)
    // A read that returned no envelope is not "no listings" — it is a read we cannot interpret.
    if (!data || typeof data !== "object" || !Array.isArray(data.rows) || !data.coverage || typeof data.coverage !== "object") {
      throw new Error("get_topshot_listings_by_serial returned no rows/coverage envelope")
    }
    const coverage = data.coverage as SerialSearchCoverage
    if (typeof coverage.confirmed_count !== "number" || typeof coverage.unconfirmed_count !== "number") {
      throw new Error("get_topshot_listings_by_serial coverage carried no counts")
    }
    const rows: SerialSearchRow[] = (data.rows as any[]).map((r) => ({
      nft_id: String(r.nft_id),
      listing_resource_id: r.listing_resource_id ?? null,
      price_usd: Number(r.price_usd),
      serial_number: Number(r.serial_number),
      confirmation: r.confirmation,
      listed_at: r.listed_at ?? null,
      last_seen_at: r.last_seen_at ?? null,
      book_verified_at: r.book_verified_at ?? null,
      edition_id: r.edition_id ?? null,
      external_id: r.external_id ?? null,
      player_name: r.player_name ?? null,
      set_name: r.set_name ?? null,
      tier: r.tier ?? null,
      parallel: r.parallel ?? null,
      circulation_count: r.circulation_count != null ? Number(r.circulation_count) : null,
      fmv_usd: r.fmv_usd != null ? Number(r.fmv_usd) : null,
    }))

    return NextResponse.json(
      { serial, filters: { maxPrice: maxPrice ?? null, tier: tier ?? null }, coverage, rows },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } },
    )
  } catch (err) {
    console.log("[topshot-serial-search] error:", err instanceof Error ? err.message : String(err))
    return apiErrorResponse(err, "api/topshot-serial-search")
  }
}
