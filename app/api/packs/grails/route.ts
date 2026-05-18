// app/api/packs/grails/route.ts
//
// GET /api/packs/grails?collection=<slug>&sort=<key>&minGrails100=<n>
//                       &minMaxPull=<n>&limit=<n>&buyableOnly=true
//
// Returns grail-focused pack metrics joined to the listing-row metadata
// (title, image_url, primary_price, secondary_ask, pack_ev, value_ratio,
// total_sealed, depletion_pct, slots, primary_available, secondary_available).
// Backs the "Grails" view mode on the packs page.
//
// pack_grail_metrics_mv and pack_table_rows are both views, so PostgREST
// can't auto-embed them — we fetch the two sides and join client-side here.
//
// When `buyableOnly=true`, the pack_table_rows side is filtered to rows where
// primary_available or secondary_available is true, then grail rows whose
// dist_id doesn't survive that filter are dropped. The flag is sticky in the
// URL so the leaderboard is shareable in either state.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { COLLECTION_UUID_BY_SLUG, SLUG_TO_DB_SLUG } from "@/lib/collections"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

type SortKey = "maxPull" | "evPerSlot" | "weightedGrailValue"
const ALLOWED_SORTS = new Set<SortKey>(["maxPull", "evPerSlot", "weightedGrailValue"])

interface GrailMvRow {
  collection_id: string
  dist_id: string
  edition_count_pullable: number
  editions_with_fmv: number | null
  fmv_coverage_pct: number | null
  max_pull_fmv: number | null
  max_pull_player: string | null
  max_pull_set: string | null
  max_pull_tier: string | null
  max_pull_thumbnail: string | null
  grails_25: number
  grails_100: number
  grails_500: number
  grails_1000: number
  ultimate_count: number
  legendary_count: number
  rare_count: number
  weighting_method: string
  weighted_pool_value: number | null
  weighted_grail_value_100plus: number | null
  ev_per_slot: number | null
  prob_grail_25_per_slot: number | null
  prob_grail_100_per_slot: number | null
  prob_grail_500_per_slot: number | null
  prob_grail_1000_per_slot: number | null
  prob_ultimate_per_slot: number | null
  prob_legendary_per_slot: number | null
}

interface PackRowMeta {
  dist_id: string
  title: string | null
  image_url: string | null
  primary_price: number | null
  secondary_ask: number | null
  pack_ev: number | null
  value_ratio: number | null
  total_sealed: number | null
  depletion_pct: number | null
  slots: number | null
  primary_available: boolean | null
  secondary_available: boolean | null
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const collectionRaw = (url.searchParams.get("collection") ?? "").trim()
  const sortRaw = (url.searchParams.get("sort") ?? "weightedGrailValue") as SortKey
  const minGrails100 = parseInt(url.searchParams.get("minGrails100") ?? "1", 10)
  const minMaxPull = parseFloat(url.searchParams.get("minMaxPull") ?? "0")
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "25", 10)
  const buyableOnly = (url.searchParams.get("buyableOnly") ?? "").toLowerCase() === "true"

  if (!collectionRaw) {
    return NextResponse.json({ error: "collection required" }, { status: 400 })
  }

  // Accept both hyphen-form (nba-top-shot) and DB underscore form (nba_top_shot).
  let collectionUuid: string | null = null
  if (COLLECTION_UUID_BY_SLUG[collectionRaw]) {
    collectionUuid = COLLECTION_UUID_BY_SLUG[collectionRaw]
  } else {
    const hyphen = Object.entries(SLUG_TO_DB_SLUG).find(([, db]) => db === collectionRaw)?.[0]
    if (hyphen) collectionUuid = COLLECTION_UUID_BY_SLUG[hyphen]
  }
  if (!collectionUuid) {
    return NextResponse.json({ error: "unknown collection: " + collectionRaw }, { status: 400 })
  }

  const sort: SortKey = ALLOWED_SORTS.has(sortRaw) ? sortRaw : "weightedGrailValue"
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 25
  const minG100 = Number.isFinite(minGrails100) && minGrails100 >= 0 ? minGrails100 : 1
  const minMP = Number.isFinite(minMaxPull) && minMaxPull >= 0 ? minMaxPull : 0

  const sortColumn =
    sort === "maxPull" ? "max_pull_fmv"
    : sort === "evPerSlot" ? "ev_per_slot"
    : "weighted_grail_value_100plus"

  try {
    const { data: grails, error: gErr } = await sb
      .from("pack_grail_metrics_mv")
      .select("*")
      .eq("collection_id", collectionUuid)
      .gte("grails_100", minG100)
      .gte("max_pull_fmv", minMP)
      .order(sortColumn, { ascending: false, nullsFirst: false })
      .limit(limit)

    if (gErr) {
      console.error("[packs/grails] mv read", gErr.message)
      return NextResponse.json({ error: gErr.message }, { status: 500 })
    }
    const grailRows = (grails ?? []) as GrailMvRow[]
    if (grailRows.length === 0) {
      return NextResponse.json({ rows: [], collection_id: collectionUuid }, {
        headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
      })
    }

    const distIds = grailRows.map((g) => g.dist_id)
    let metaQuery = sb
      .from("pack_table_rows")
      .select("dist_id, title, image_url, primary_price, secondary_ask, pack_ev, value_ratio, total_sealed, depletion_pct, slots, primary_available, secondary_available")
      .eq("collection_id", collectionUuid)
      .in("dist_id", distIds)

    if (buyableOnly) {
      metaQuery = metaQuery.or("primary_available.eq.true,secondary_available.eq.true")
    }

    const { data: meta, error: mErr } = await metaQuery

    if (mErr) {
      console.error("[packs/grails] meta read", mErr.message)
      return NextResponse.json({ error: mErr.message }, { status: 500 })
    }
    const metaMap = new Map<string, PackRowMeta>()
    for (const m of (meta ?? []) as PackRowMeta[]) metaMap.set(m.dist_id, m)

    const rows = grailRows
      .map((g) => ({
        ...g,
        meta: metaMap.get(g.dist_id) ?? null,
      }))
      // When buyableOnly is on, drop grail rows whose dist didn't survive the
      // pack_table_rows availability filter.
      .filter((r) => !buyableOnly || r.meta !== null)

    return NextResponse.json({ rows, collection_id: collectionUuid, sort, limit, buyableOnly }, {
      headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=300" },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[packs/grails] unexpected", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
