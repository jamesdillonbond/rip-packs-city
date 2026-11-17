// app/api/public/trade-block/[code]/route.ts
//
// One Trade Block listing, public read. Its offered assets are re-checked against RPC's
// index of the account they were posted from: in_index true / false ("may have moved") /
// null (not re-checked — the check failed). Never a wallet address.
//
//   GET -> { listing: ListingView, signed_in: boolean }

import { NextRequest, NextResponse } from "next/server"
import { boardUnavailable } from "@/lib/insights/board-error"
import { supabaseAdmin } from "@/lib/supabase"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { usernamesFor } from "@/lib/trade-room/view"
import { loadListing, stillIndexed, TradeBlockError } from "@/lib/trade-block/store"
import { listingView } from "@/lib/trade-block/view"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ code: string }> }

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { code } = await ctx.params
  try {
    const loaded = await loadListing(supabaseAdmin, code)
    const [names, inIndex] = await Promise.all([
      usernamesFor(supabaseAdmin, [loaded.listing.user_id]),
      stillIndexed(supabaseAdmin, loaded.items.filter((i) => i.role === "offer")),
    ])
    let viewer: string | null = null
    try {
      viewer = (await getCurrentUser())?.id ?? null
    } catch {
      viewer = null
    }
    return NextResponse.json({ listing: listingView(loaded, names, viewer, Date.now(), inIndex), signed_in: viewer !== null }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    if (e instanceof TradeBlockError) return NextResponse.json({ error: e.copy, code: e.code }, { status: e.status, headers: { "Cache-Control": "no-store" } })
    return boardUnavailable(e, "trade-block/[code]", "This listing isn't available right now. Try again in a moment.")
  }
}
