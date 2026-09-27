// app/api/panini-collection/route.ts
//
// Panini Collection tab backend (2026-09-27). What RPC has SEEN under a Panini
// username, via panini_owner_cards (migration 20260927183808). The shared
// Collection tab keys on a wallet ADDRESS in wallet_moments_cache, where Panini
// has zero rows — a Panini owner is a USERNAME (lib/address.ts isPaniniUsername).
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · RPC reads a card's holder only when it reads the card, and it reads a card
//     only once it has been LISTED: 2,552 of 3,266 owners appear ONLY through
//     their own listings (2026-09-27). So the payload is "cards seen under this
//     username", with seen / listed-now counts and the last-seen time, and the
//     client never calls it a collection total.
//   · A username RPC has never seen is `cardsSeen: 0` — the client says "not
//     seen", never "holds nothing".
//   · FMV is the EDITION's current FMV; cards with none are counted
//     (`fmvPricedCards` < `cardsSeen`), never priced as $0.
//   · Media paths go through paniniAssetUrl (absolute on the measured host).
//   · A malformed username is a 400 for the username; a failed read is a 503.
//
// ── PROFILE HOLDINGS (2026-09-27, migration 20260927194743) ─────────────────
// For a username a collector walk has read (linked on an RPC profile, or walked by
// the box's owner), `profile` carries the cards read off the PUBLIC Panini profile
// — the whole collection, as of the walk — via panini_profile_holdings. `walk: null`
// means "never walked", which the tab says, never "holds nothing". Either read
// failing is a 503: half a collection is not rendered as the collection.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { normalizePaniniUsername } from "@/lib/profile/collector-identities"
import { parsePaniniOwnerCards, parsePaniniProfileHoldings } from "@/lib/panini/owner-cards"

export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("username") ?? "").trim()
  if (!raw) {
    return NextResponse.json({ error: "Enter a Panini username.", code: "bad_request", retryable: false }, { status: 400 })
  }
  const username = normalizePaniniUsername(raw)
  if (!username) {
    return NextResponse.json(
      { error: "That doesn't look like a Panini username (2–16 letters, numbers, . _ -).", code: "bad_request", retryable: false },
      { status: 400 },
    )
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const [seen, held] = await Promise.all([
      boundedRead(db.rpc("panini_owner_cards", { p_username: username, p_limit: 200 }), "panini-collection"),
      boundedRead(db.rpc("panini_profile_holdings", { p_username: username, p_limit: 500 }), "panini-collection-profile"),
    ])
    if (seen.error) return apiErrorResponse(seen.error, "api/panini-collection", "This collection is unavailable right now.")
    if (held.error) return apiErrorResponse(held.error, "api/panini-collection", "This collection is unavailable right now.")
    const parsed = parsePaniniOwnerCards(seen.data)
    const profile = parsePaniniProfileHoldings(held.data)
    if (!parsed || !profile) {
      return apiErrorResponse(new Error("panini collection RPC returned an unexpected shape"), "api/panini-collection", "This collection is unavailable right now.")
    }
    return NextResponse.json({ ...parsed, profile }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (err) {
    return apiErrorResponse(err, "api/panini-collection", "This collection is unavailable right now.")
  }
}
