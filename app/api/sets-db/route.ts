// app/api/sets-db/route.ts
// Generic, DB-driven sets endpoint for collections without a chain-specific
// /api/{coll}-sets implementation (Golazos, etc.). Reads the sets, editions,
// and wallet_moments_cache tables — no chain or GQL calls. Returns the same
// SetsResponse shape the sets page consumes.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { classifySetTier } from "@/lib/set-completion-tier"
import { safeApiError, statusForSafeError } from "@/lib/api-error"

const COLLECTION_UUID_MAP: Record<string, string> = {
  "nba-top-shot": "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  "nfl-all-day": "dee28451-5d62-409e-a1ad-a83f763ac070",
  "laliga-golazos": "06248cc4-b85f-47cd-af67-1855d14acd75",
  "disney-pinnacle": "7dd9dd11-e8b6-45c4-ac99-71331f959714",
}

type EditionRow = {
  id: string
  set_id: string | null
  set_name: string | null
  player_name: string | null
  tier: string | null
  thumbnail_url: string | null
  external_id: string | null
}

export const dynamic = "force-dynamic"

// PostgREST enforces a hard 1000-row cap on this project, so a bare .limit(50000)
// silently returns only the first 1000 rows — which would truncate a collection's
// edition catalog (and a whale's owned moments) and quietly corrupt set-completion.
// Page through with .range() windows until a short page signals the end. The page
// builder MUST impose a stable .order() or pagination skips/duplicates rows.
async function fetchAllPaged<T = any>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildPage: (from: number, to: number) => any,
  maxRows = 60000,
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await buildPage(from, from + PAGE - 1)
    if (error) throw error
    const rows: T[] = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim().toLowerCase()
  const collectionSlug = req.nextUrl.searchParams.get("collection") ?? ""
  if (!wallet) return NextResponse.json({ error: "wallet required" }, { status: 400 })

  const collectionId = COLLECTION_UUID_MAP[collectionSlug]
  if (!collectionId) return NextResponse.json({ error: "Unknown collection" }, { status: 400 })

  try {
    // 1. All editions in this collection (set_id, name, etc.). Paged: a
    //    collection can hold far more than the 1000-row cap, and a truncated
    //    catalog would silently drop whole sets from completion tracking.
    const editions: EditionRow[] = await fetchAllPaged<EditionRow>((from, to) =>
      (supabaseAdmin as any)
        .from("editions")
        .select("id, set_id, set_name, player_name, tier, thumbnail_url, external_id")
        .eq("collection_id", collectionId)
        .not("set_id", "is", null)
        .order("id", { ascending: true })
        .range(from, to)
    )

    // 2. All sets in this collection
    const { data: setsRaw, error: sErr } = await (supabaseAdmin as any)
      .from("sets")
      .select("id, name")
      .eq("collection_id", collectionId)
    if (sErr) throw sErr
    const setMeta = new Map<string, string>()
    for (const s of setsRaw ?? []) setMeta.set(s.id, s.name ?? "")

    // 3. Wallet-owned moments in this collection. Paged: a whale can own well
    //    over 1000 moments, and truncating them would under-count completion.
    const owned = await fetchAllPaged<{ moment_id: string; edition_key: string; serial_number: number | null; is_locked: boolean | null }>((from, to) =>
      (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .select("moment_id, edition_key, serial_number, is_locked")
        .eq("wallet_address", wallet)
        .eq("collection_id", collectionId)
        .order("moment_id", { ascending: true })
        .range(from, to)
    )

    // Index: edition external_id -> edition row
    const edByExt = new Map<string, EditionRow>()
    for (const e of editions) {
      if (e.external_id) edByExt.set(e.external_id, e)
    }

    // Owned editions grouped by set_id (preferring lowest serial owned)
    type OwnedAgg = {
      editionId: string
      momentId: string
      playerName: string
      tier: string
      serial: number | null
      thumb: string | null
      isLocked: boolean
    }
    const ownedBySet = new Map<string, OwnedAgg[]>()
    const ownedEditionIds = new Set<string>()
    for (const o of owned) {
      const ed = edByExt.get(o.edition_key)
      if (!ed?.set_id) continue
      ownedEditionIds.add(ed.id)
      const list = ownedBySet.get(ed.set_id) ?? []
      list.push({
        editionId: ed.id,
        momentId: o.moment_id,
        playerName: ed.player_name ?? "Unknown",
        tier: (ed.tier ?? "COMMON").toUpperCase(),
        serial: o.serial_number,
        thumb: ed.thumbnail_url,
        isLocked: !!o.is_locked,
      })
      // Store the (possibly newly-created) list back — without this a freshly
      // created list for a set is pushed to but never re-inserted, so every set
      // read ownedRows as [] and reported 0 owned / 0% completion. (Mirrors the
      // edsBySet loop below, which does call .set.)
      ownedBySet.set(ed.set_id, list)
    }

    // Editions grouped by set_id
    const edsBySet = new Map<string, EditionRow[]>()
    for (const e of editions) {
      if (!e.set_id) continue
      const list = edsBySet.get(e.set_id) ?? []
      list.push(e)
      edsBySet.set(e.set_id, list)
    }

    // Build SetProgress rows
    const sets: any[] = []
    for (const [setId, eds] of edsBySet) {
      const setName = setMeta.get(setId) ?? eds[0]?.set_name ?? "Unknown Set"
      const ownedRows = ownedBySet.get(setId) ?? []
      const ownedEdSet = new Set(ownedRows.map(o => o.editionId))
      const totalEditions = eds.length
      // Dedupe owned by editionId (multiple copies = single owned entry)
      const seen = new Set<string>()
      const ownedDedup = ownedRows.filter(o => {
        if (seen.has(o.editionId)) return false
        seen.add(o.editionId)
        return true
      })
      const ownedCount = ownedDedup.length
      const missingEds = eds.filter(e => !ownedEdSet.has(e.id))
      const lockedOwnedCount = ownedDedup.filter(o => o.isLocked).length
      const tradeableOwnedCount = ownedCount - lockedOwnedCount
      const completionPct = totalEditions > 0 ? Math.round((ownedCount / totalEditions) * 100) : 0
      const tradeableCompletionPct = totalEditions > 0
        ? Math.round((tradeableOwnedCount / totalEditions) * 100)
        : 0

      sets.push({
        setId,
        setName,
        totalEditions,
        ownedCount,
        missingCount: missingEds.length,
        listedCount: 0,
        completionPct,
        totalMissingCost: null,
        lowestSingleAsk: null,
        bottleneckPrice: null,
        bottleneckPlayerName: null,
        // Classify by completion progress, not just by 100%/else — labelling a
        // half-finished Golazos set "unpriced" hides real progress (Set audit B6).
        // This surface has NO ask/price pipeline, so it passes
        // pricingAvailable:false and gets the progress-only ladder. The
        // behaviour is unchanged; it just no longer defines its own thresholds.
        tier: classifySetTier({
          completionPct,
          missingCount: missingEds.length,
          pricingAvailable: false,
        }),
        owned: ownedDedup.map(o => ({
          playId: o.editionId,
          playerName: o.playerName,
          tier: o.tier,
          serialNumber: o.serial,
          thumbnailUrl: o.thumb,
          topshotUrl: "",
          isLocked: o.isLocked,
          momentId: o.momentId,
        })),
        missing: missingEds.slice(0, 200).map(e => ({
          playId: e.id,
          playerName: e.player_name ?? "—",
          tier: (e.tier ?? "COMMON").toUpperCase(),
          lowestAsk: null,
          thumbnailUrl: e.thumbnail_url,
          topshotUrl: "",
          fmv: null,
          fmvConfidence: null,
          hasBadge: false,
          badgeSlugs: [],
        })),
        asksEnriched: false,
        costConfidence: "low" as const,
        lockedOwnedCount,
        tradeableOwnedCount,
        tradeableCompletionPct,
      })
    }

    sets.sort((a, b) => b.completionPct - a.completionPct)

    return NextResponse.json(
      {
        wallet,
        resolvedAddress: wallet,
        totalSets: sets.length,
        completeSets: sets.filter(s => s.completionPct === 100).length,
        sets,
        generatedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" } }
    )
  } catch (err) {
    // Same leak as /api/sets (deep-audit D3): the sets page renders `body.error`
    // verbatim, and this route backs the AllDay / Golazos / Pinnacle / UFC Set
    // Trackers. Returning err.message put raw Postgres text on a public page.
    console.error("[/api/sets-db] error:", err)
    const safe = safeApiError(err, "Failed to load sets.")
    return NextResponse.json(safe, {
      status: statusForSafeError(safe),
      headers: safe.retryable ? { "Retry-After": "60" } : undefined,
    })
  }
}
