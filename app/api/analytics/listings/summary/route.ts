// GET /api/analytics/listings/summary
//
// Thin wrapper over analytics_listings_summary(p_collections). Returns
// three sections — open Flowty loan offers, Top Shot orderbook sample,
// and per-collection Sniper-feed marketplace asks — plus methodology
// caveats describing the data sources.
//
// Query params:
//   collections  comma-separated list  (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { ListingsSummaryResponse } from "@/lib/analytics-types"
import { computeUfcAptosSniperFeed } from "@/lib/sniper/ufc-aptos"
import { summarizeUfcAptosBook, withUfcAptosBook } from "@/lib/analytics/ufc-aptos-book"

export const dynamic = 'force-dynamic'
export const revalidate = 300

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))

    console.log(
      `[analytics/listings/summary] start collections=${collections?.join(",") ?? "all"}`
    )

    const { data, error } = await rpcWithRetry<ListingsSummaryResponse>(
      supabaseAdmin,
      "analytics_listings_summary",
      { p_collections: collections }
    )

    if (error) {
      console.log("[analytics/listings/summary] rpc_error", error.message)
      return NextResponse.json({ error: "listings_summary_failed" }, { status: 500 })
    }

    // 2026-11-26: UFC Strike trades on Aptos; the RPC reads Flow listings only. Its row is
    // rebuilt from the live Aptos book (lib/analytics/ufc-aptos-book.ts). A failed Aptos read
    // fails the request — the card says "couldn't load", never "No live listings."
    if (data && collections?.includes("ufc")) {
      const feed = await computeUfcAptosSniperFeed({})
      data.marketplace_listings = withUfcAptosBook(
        data.marketplace_listings,
        summarizeUfcAptosBook(feed.deals.map((d) => d.askPrice)),
      )
    }

    console.log(
      `[analytics/listings/summary] ok elapsed=${Date.now() - t0}ms loan_offers=${data?.loan_offers?.count ?? 0} ts_orderbook=${data?.topshot_orderbook?.count ?? 0}`
    )

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
      },
    })
  } catch (e: any) {
    console.log("[analytics/listings/summary] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "listings_summary_failed" }, { status: 500 })
  }
}
