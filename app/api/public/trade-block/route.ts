// app/api/public/trade-block/route.ts
//
// The Trade Block, public read (Trevor, 2026-11-02: "Browsing can be public"). Open,
// unexpired listings, newest first: username, what they'd trade, what they want, RPC FMV
// only where confident — never a wallet address, never a confidence tier.
//
//   GET ?collection=<slug>&q=<player|set>&edition=<catalog key>&before=<created_at cursor>
//     -> { listings: ListingView[], next_before: string | null }
//
// A failed read answers through boardUnavailable (503 + retryable copy), never as an
// empty block: "no listings" is published only when the read succeeded and found none.

import { NextRequest, NextResponse } from "next/server"
import { boardUnavailable } from "@/lib/insights/board-error"
import { supabaseAdmin } from "@/lib/supabase"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { usernamesFor } from "@/lib/trade-room/view"
import { collectionBySlug } from "@/lib/trade-block/rules"
import { listOpenListings } from "@/lib/trade-block/store"
import { listingView } from "@/lib/trade-block/view"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const slug = sp.get("collection")
  const c = slug ? collectionBySlug(slug) : null
  // SUBSTITUTION guard: an unknown collection is refused, never answered with every listing
  if (slug && !c) return NextResponse.json({ error: "Unknown collection.", code: "bad_collection" }, { status: 400 })
  const edition = sp.get("edition")
  // an edition key means nothing without its collection (keys collide across collections)
  if (edition && (!c || edition.length > 120)) return NextResponse.json({ error: "An edition filter needs its collection.", code: "bad_edition" }, { status: 400 })
  const before = sp.get("before")
  if (before && !Number.isFinite(Date.parse(before))) return NextResponse.json({ error: "Bad cursor.", code: "bad_cursor" }, { status: 400 })
  try {
    const now = Date.now()
    const page = await listOpenListings(supabaseAdmin, { collectionId: c?.id ?? null, q: sp.get("q"), editionKey: edition, before }, now)
    const names = await usernamesFor(supabaseAdmin, page.listings.map((l) => l.listing.user_id))
    let viewer: string | null = null
    try {
      viewer = (await getCurrentUser())?.id ?? null
    } catch {
      viewer = null
    }
    return NextResponse.json(
      { listings: page.listings.map((l) => listingView(l, names, viewer, now)), next_before: page.next_before },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (e) {
    return boardUnavailable(e, "trade-block", "The Trade Block isn't available right now. Try again in a moment.")
  }
}
