// app/api/public/profile/[username]/packs/route.ts
//
// GET /api/public/profile/<username>/packs — public, no auth.
//
// Sealed packs held across the wallets this profile OWNS, at the lowest live ask,
// shown under the public profile's Portfolio FMV (Trevor, 2026-11-21: "show the
// pack low ask total, when showing the aggregated wallet value"). Summed over
// exactly the wallets the profile's FMV sums (publicProfileOwnedAddresses — the
// estate's ownership rule), so a stranger's saved address never counts.
//
// Publishes TOTALS only — never an address. Fetched by the client after mount,
// not during SSR, so crawler traffic on /profile/<u> (14k hits/12h in the 08-06
// crawl) does not pay for pack reads; the CDN holds each answer 10 minutes.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { supabaseAdmin } from "@/lib/supabase"
import { getPublicProfile, publicProfileOwnedAddresses } from "@/lib/profile/public-profile"
import { packWalletAddresses, readHeldPackTotal } from "@/lib/packs/held-pack-total"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin
export const maxDuration = 30

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  const { username } = await params
  const result = await getPublicProfile(username, "packs")
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  try {
    const addrs = packWalletAddresses(publicProfileOwnedAddresses(result.data))
    const t = await readHeldPackTotal(sb, addrs, "api/public/profile/packs")
    return NextResponse.json({
      held: t.held,
      listed: t.listed,
      low_ask_usd: t.lowAskUsd,
      unpriced: t.unpriced ?? 0,
      wallets_failed: t.walletsFailed,
    }, {
      // A partial answer is not cached at the edge — the next visitor retries.
      headers: { "Cache-Control": t.walletsFailed > 0 ? "no-store" : "public, s-maxage=600, stale-while-revalidate=3600" },
    })
  } catch (err) {
    return apiErrorResponse(err, "api/public/profile/packs")
  }
}
