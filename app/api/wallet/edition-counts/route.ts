import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionUuid } from "@/lib/collections"

// GET /api/wallet/edition-counts?wallet=0x...&collection=nba-top-shot
//
// Aggregates wallet_moments_cache for the given wallet + collection into a
// per-edition_key {owned, locked} count. Powers the sniper "Edition Owned /
// Locked" column ("3 / 2" format) without round-tripping the full row set.
//
// Public read by design — the same wallet view is reachable through the
// Collection Analyzer page already.

export const dynamic = "force-dynamic"

interface CountRow {
  edition_key: string | null
  is_locked: boolean | null
}

export async function GET(req: NextRequest) {
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
    // Pull edition_key + is_locked for every cached moment in this wallet +
    // collection. Service-role client; the only field we surface is the
    // grouped count, so this never leaks individual moment IDs.
    const PAGE = 1000
    const counts = new Map<string, { owned: number; locked: number }>()
    let offset = 0
    while (true) {
      const { data, error } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .select("edition_key, is_locked")
        .eq("wallet_address", wallet.toLowerCase())
        .eq("collection_id", collectionId)
        .not("edition_key", "is", null)
        .range(offset, offset + PAGE - 1)
      if (error) {
        console.warn("[wallet/edition-counts] query error: " + error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      const rows = (data ?? []) as CountRow[]
      for (const r of rows) {
        const key = r.edition_key
        if (!key) continue
        const slot = counts.get(key) ?? { owned: 0, locked: 0 }
        slot.owned += 1
        if (r.is_locked) slot.locked += 1
        counts.set(key, slot)
      }
      if (rows.length < PAGE) break
      offset += PAGE
      if (offset > 50_000) break // hard safety cap
    }

    const editions: Record<string, { owned: number; locked: number }> = {}
    for (const [k, v] of counts) editions[k] = v

    return NextResponse.json(
      {
        wallet: wallet.toLowerCase(),
        collection,
        editions,
        editionCount: counts.size,
      },
      { headers: { "Cache-Control": "private, max-age=60" } }
    )
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn("[wallet/edition-counts] exception: " + msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
