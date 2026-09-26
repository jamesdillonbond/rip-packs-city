import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionUuid } from "@/lib/collections"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { normalizeAddress } from "@/lib/address"

// GET /api/wallet/edition-counts?wallet=0x...&collection=nba-top-shot
//
// Aggregates wallet_moments_cache for the given wallet + collection into a
// per-edition_key {owned, locked} count. Powers the sniper "Edition Owned /
// Locked" column ("3 / 2" format) without round-tripping the full row set.
//
// Public read by design — the same wallet view is reachable through the
// Collection Analyzer page already.

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  // ⛔ 2026-09-19 — THIS ROUTE FOLDED THE WALLET AND wallet_moments_cache STORES
  // CANDY BASE58 VERBATIM, so a Candy address matched zero rows and the route
  // answered 200 with `editionCount: 0` — a confident "you own nothing" built
  // from a mangled key. Measured live before the fix: the response echoed back
  // `"wallet":"12j1uhkqcbyauomkvxdp2ma6mst3k8wx8ohhhv8genak"`, i.e. it published
  // the corrupted address as the one it had read.
  //
  // ⚠ The echo below is normalized for the same reason the query is: a response
  // that names a different address than the one it queried is unfalsifiable by
  // the reader. `normalizeAddress` lowercases Cadence/EVM — so every Flow caller
  // is byte-identical — and leaves base58 alone.
  //
  // This is the FOURTH route in this class; the other three (profile/top-moments,
  // profile/hero-moment, profile/activity) were fixed earlier the same day. It
  // was missed then because that sweep was scoped to app/api/profile/.
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim() ?? ""
  const collection = req.nextUrl.searchParams.get("collection")?.trim() ?? "nba-top-shot"

  if (!wallet) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 })
  }

  const collectionId = getCollectionUuid(collection)
  if (!collectionId) {
    return NextResponse.json({ error: "unknown collection slug" }, { status: 400 })
  }

  try {
    // ⛔ 2026-09-25 — THIS USED TO PAGE ROWS 1000 AT A TIME BY OFFSET AND STOP
    // AFTER ~51 PAGES (`if (offset > 50_000) break`), then answer 200 as if the
    // list were complete. Three live wallets hold more than 50k moments in one
    // collection (largest 153,544), so every edition past the cap read as
    // "Owned: 0" on Market, Sniper and the player-page tiles — a PAGED read that
    // breaks returns a partial list no caller can tell from a whole one. The
    // aggregate now runs in SQL (get_wallet_edition_counts, migration
    // 20260926050443): one jsonb value, no row cap, 2.0 s on the largest wallet.
    const { data, error } = await boundedRead((supabaseAdmin as any).rpc("get_wallet_edition_counts", {
      p_wallet: normalizeAddress(wallet),
      p_collection_id: collectionId,
    }), "api/wallet/edition-counts/get_wallet_edition_counts")
    if (error) {
      console.warn("[wallet/edition-counts] query error: " + error.message)
      return apiErrorResponse(error, "api/wallet/edition-counts")
    }
    // The function always returns an object ('{}' for an empty wallet). Anything
    // else is a broken read, and answering it as `{}` would publish "owns
    // nothing" — so it is an error, not an empty result.
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return NextResponse.json({ error: "unexpected edition-counts shape" }, { status: 502, headers: { "Cache-Control": "no-store" } })
    }
    const editions: Record<string, { owned: number; locked: number }> = {}
    for (const [k, v] of Object.entries(data as Record<string, { owned?: unknown; locked?: unknown }>)) {
      editions[k] = { owned: Number(v?.owned ?? 0), locked: Number(v?.locked ?? 0) }
    }

    return NextResponse.json(
      {
        wallet: normalizeAddress(wallet),
        collection,
        editions,
        editionCount: Object.keys(editions).length,
      },
      { headers: { "Cache-Control": "private, max-age=60" } }
    )
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn("[wallet/edition-counts] exception: " + msg)
    return apiErrorResponse(err, "api/wallet/edition-counts")
  }
}
