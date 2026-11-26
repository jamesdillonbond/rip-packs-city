// app/api/public/profile/[username]/panini/route.ts
//
// GET /api/public/profile/<username>/panini — public, no auth.
//
// The Panini cards this profile's owner has linked (by Panini username), at their newest
// recorded collection value — added into the public profile's Total Assets and Portfolio FMV
// (Trevor, 2026-11-25: Panini "should be" in Portfolio FMV; the dashboard does the same).
//
// Publishes TOTALS only — never a Panini username or a user id. Fetched after mount, CDN-held
// 10 minutes like the sealed-pack total. A failed read is a 5xx; the page then says Panini
// couldn't load and adds nothing.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { supabaseAdmin } from "@/lib/supabase"
import { getPublicProfile, publicProfileOwnerId } from "@/lib/profile/public-profile"
import { readLinkedPaniniValue } from "@/lib/panini/linked-value"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin
export const maxDuration = 30

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  const { username } = await params
  const result = await getPublicProfile(username, "panini")
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  try {
    const owner = publicProfileOwnerId(result.data)
    if (!owner) return NextResponse.json({ cards: 0, fmv_usd: 0 }, { headers: { "Cache-Control": "public, s-maxage=600" } })
    const v = await readLinkedPaniniValue(sb, owner, "api/public/profile/panini")
    if (v.failed) return apiErrorResponse(new Error("linked Panini value read failed"), "api/public/profile/panini")
    return NextResponse.json(
      { cards: v.cards, fmv_usd: v.fmvUsd },
      { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600" } },
    )
  } catch (err) {
    return apiErrorResponse(err, "api/public/profile/panini")
  }
}
