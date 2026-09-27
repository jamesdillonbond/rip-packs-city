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

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { normalizePaniniUsername } from "@/lib/profile/collector-identities"
import { parsePaniniOwnerCards } from "@/lib/panini/owner-cards"

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
    const { data, error } = await boundedRead(
      (supabaseAdmin as any).rpc("panini_owner_cards", { p_username: username, p_limit: 200 }),
      "panini-collection",
    )
    if (error) return apiErrorResponse(error, "api/panini-collection", "This collection is unavailable right now.")
    const parsed = parsePaniniOwnerCards(data)
    if (!parsed) {
      return apiErrorResponse(new Error("panini_owner_cards returned an unexpected shape"), "api/panini-collection", "This collection is unavailable right now.")
    }
    return NextResponse.json(parsed, { headers: { "Cache-Control": "private, no-store" } })
  } catch (err) {
    return apiErrorResponse(err, "api/panini-collection", "This collection is unavailable right now.")
  }
}
