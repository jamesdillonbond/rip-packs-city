import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { getCollectionByUuid } from "@/lib/collections"
import { resolveLiveAsks } from "@/lib/asks/edition-live-ask"

// POST /api/best-asks — the LIVE low ask per edition, for the collection binder
// (known-issues #182, 2026-10-10). The binder's row RPC carries only
// fmv_snapshots.floor_price_usd, which on a sales-priced row is the window's
// lowest SALE, not a listing; the client enriches rows from here the same way it
// enriches bids from /api/best-offers. The source chain and the <= 3x-FMV gate
// are get_team_checklist's (lib/asks/edition-live-ask.ts).
//
// Body: { collectionId: <collection UUID>, editionKeys: string[] }
// Reply: { results: [{ editionKey, ask, askSource }], partial: boolean }
//   - an edition with no connected live ask is simply absent from `results`;
//   - `partial: true` means a source read FAILED, so an absent key is UNKNOWN
//     rather than "no ask" (the client renders nothing either way, so no claim
//     is made; the flag is for anyone who would read absence as a fact).

const MAX_KEYS = 1000

export async function POST(req: NextRequest) {
  let body: { collectionId?: unknown; editionKeys?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }
  const collectionId = typeof body.collectionId === "string" ? body.collectionId.trim().toLowerCase() : ""
  // A present but unknown collection is refused, never answered with another
  // collection's asks (the substitution rule).
  if (!collectionId || !getCollectionByUuid(collectionId)) {
    return NextResponse.json({ error: "unknown_collection" }, { status: 400 })
  }
  const editionKeys = Array.isArray(body.editionKeys)
    ? body.editionKeys.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim())
    : []
  if (editionKeys.length > MAX_KEYS) {
    return NextResponse.json({ error: `at most ${MAX_KEYS} editionKeys` }, { status: 400 })
  }
  if (editionKeys.length === 0) return NextResponse.json({ results: [], partial: false })

  try {
    const { asks, errors } = await resolveLiveAsks(supabaseAdmin, collectionId, editionKeys)
    if (errors.length > 0) console.log(`[best-asks] partial (${errors.length}): ${errors[0]}`)
    const results = [...asks].map(([editionKey, a]) => ({ editionKey, ask: a.ask, askSource: a.source }))
    return NextResponse.json({ results, partial: errors.length > 0 })
  } catch (e) {
    return apiErrorResponse(e, "api/best-asks")
  }
}
