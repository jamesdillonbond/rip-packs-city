import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
// Canonical slug↔DB-slug bridge — a hand-rolled local copy drifted here too
// (it mapped "ufc" → "ufc" but the collections row is "ufc_strike"), so a UFC
// POST resolved collection_id = null. Currently unreachable (the collection
// page guards collectionSlug !== "ufc" before POSTing), but corrected so a
// future caller can't silently no-op the write.
import { SLUG_TO_DB_SLUG } from "@/lib/collections"

// wallet_moments_cache is keyed by the 3-col unique (wallet_address,
// collection_id, moment_id) since 2026-05-06 — there is NO plain
// (wallet_address, moment_id) index, so the old 2-col onConflict this route
// used raised 42P10 and wrote nothing. The POST is also a subset double-write
// of what /api/wallet-search already persists, so it now uses the
// change-detecting upsert_wmc_batch RPC (edition_key / serial / last_seen
// only — never clobbers the metadata / fmv that other writers own) and
// requires the caller to send the collection it belongs to.

const POST_COLLECTION_ID_CACHE = new Map<string, string | null>()
async function resolveCollectionId(slug?: string): Promise<string | null> {
  if (!slug) return null
  const dbSlug = SLUG_TO_DB_SLUG[slug] ?? slug
  if (POST_COLLECTION_ID_CACHE.has(dbSlug)) return POST_COLLECTION_ID_CACHE.get(dbSlug) ?? null
  try {
    const { data } = await (supabaseAdmin as any)
      .from("collections")
      .select("id")
      .eq("slug", dbSlug)
      .single()
    const id = data?.id ?? null
    POST_COLLECTION_ID_CACHE.set(dbSlug, id)
    return id
  } catch {
    return null
  }
}

// GET /api/wallet-cache?wallet=0x... — returns cached moments for fallback
export async function GET(req: NextRequest) {
  try {
    const wallet = req.nextUrl.searchParams.get("wallet")
    if (!wallet) {
      return NextResponse.json({ ok: false, error: "wallet required" }, { status: 400 })
    }

    // PostgREST caps any single read at 1,000 rows and silently CLAMPS an
    // explicit `.limit()` above it, so the old `.limit(10000)` returned only the
    // 1,000 most-recent rows for a large collector (wmc holds 5k–13k+ rows for a
    // whale) — a silent truncation that made the fallback show a partial
    // collection. Page with `.range()` over a STABLE sort (last_seen_at DESC with
    // moment_id as the tiebreak, so equal-timestamp rows never overlap or skip
    // across windows) until a short page signals the end, bounded by a hard
    // safety cap so the response can never grow without limit.
    const PAGE = 1000
    const MAX_ROWS = 50000
    const moments: unknown[] = []
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .select("moment_id, edition_key, fmv_usd, serial_number, player_name, set_name, tier, series_number, last_seen_at")
        .eq("wallet_address", wallet)
        .order("last_seen_at", { ascending: false })
        .order("moment_id", { ascending: true })
        .range(from, from + PAGE - 1)

      if (error) {
        console.warn("[wallet-cache] GET error:", error.message)
        // A partial cache is a better fallback than none; return what we have.
        // (A first-page error leaves `moments` empty ⇒ { ok:false, moments:[] },
        // preserving the prior degrade-on-error contract.)
        return NextResponse.json({ ok: moments.length > 0, moments })
      }

      const rows = (data ?? []) as unknown[]
      moments.push(...rows)
      if (rows.length < PAGE) break
    }

    return NextResponse.json({ ok: true, moments })
  } catch (err) {
    console.warn("[wallet-cache] GET error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, moments: [] })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const wallet = body.wallet as string | undefined
    const collection = body.collection as string | undefined
    const moments = body.moments as Array<{
      momentId?: string
      editionKey?: string | null
      serial?: number | null
    }> | undefined

    if (!wallet || !Array.isArray(moments) || !moments.length) {
      return NextResponse.json({ ok: true, written: 0 })
    }

    // Without a collection we can't build the 3-col key — skip rather than
    // write a NULL-collection row that can't dedupe.
    const collectionId = await resolveCollectionId(collection)
    if (!collectionId) {
      return NextResponse.json({ ok: true, written: 0, skipped: "unresolved_collection" })
    }

    const now = new Date().toISOString()
    const rows = moments
      .filter(function(m) { return m.momentId })
      .map(function(m) {
        return {
          wallet_address: wallet,
          collection_id: collectionId,
          moment_id: m.momentId!,
          edition_key: m.editionKey ?? null,
          serial_number: m.serial ?? null,
          last_seen_at: now,
        }
      })

    if (!rows.length) {
      return NextResponse.json({ ok: true, written: 0 })
    }

    const CHUNK = 200
    let written = 0
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK)
      const { data, error } = await (supabaseAdmin as any)
        .rpc("upsert_wmc_batch", { p_rows: chunk })
      if (error) {
        console.warn("[wallet-cache] upsert_wmc_batch err:", error.message)
      } else {
        written += Number(data?.written ?? 0)
      }
    }

    return NextResponse.json({ ok: true, written })
  } catch (err) {
    console.warn("[wallet-cache] Error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: true, written: 0 })
  }
}
