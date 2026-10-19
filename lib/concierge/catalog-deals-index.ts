// lib/concierge/catalog-deals-index.ts
//
// search_catalog_deals arm for NFL All Day and LaLiga Golazos, whose asks live
// in the on-chain listing index (cached_listings_v2), not v1 `cached_listings`.
//
// 2026-10-18: v1 holds only Flowty's book for these two (108 / 100 rows against
// ~35k / ~4.3k open asks in v2), so "find me All Day deals" was answered from
// Flowty alone. All Day reads get_allday_market_editions_v3 (the /market
// page's ghost-aware, Flowty-excluding source); Golazos reads
// get_golazos_catalog_deals (migration 20261018205915) over the edition floor
// view get_edition_listings already trusts. Both answer at EDITION grain: the
// row is the edition's floor, so `serial` is null and the link is edition_url.

import { marketplaceMomentUrl } from "@/lib/collections"
import { absoluteEditionPageUrl, EDITION_FLOOR_VIEW } from "@/lib/concierge/edition-listings"

type Supabase = any

export const INDEX_DEAL_COLLECTIONS = ["nfl-all-day", "laliga-golazos"] as const

export function readsCatalogDealsFromIndex(collectionId: string | null | undefined): boolean {
  return collectionId === "nfl-all-day" || collectionId === "laliga-golazos"
}

export interface IndexDealsInput {
  player?: string | null
  /** The resolved PERSON's edition labels (player-identity crosswalk). When
   *  set, rows must match one EXACTLY — the sources' ILIKE would otherwise
   *  pull a namesake ("Marvin Harrison" ⊂ "Marvin Harrison Jr."). */
  labels?: string[] | null
  tier?: string | null
  /** Partial, case-insensitive set name; applied after the read (over-fetched). */
  setName?: string | null
  team?: string | null
  maxPrice?: number | null
  minDiscount?: number | null
  hasBadge?: boolean | null
  limit?: number | null
}

export interface IndexDeal {
  player: string | null
  set: string | null
  tier: string | null
  serial: null
  price: number
  fmv: number | null
  confidence: string | null
  discount_pct: number | null
  badges: unknown
  buy_url: string | null
  edition_url: string | null
}

const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** `{ ok: false }` is a FAILED read — never to be reported as "no deals". */
export async function fetchIndexCatalogDeals(
  supabase: Supabase,
  collectionId: "nfl-all-day" | "laliga-golazos",
  input: IndexDealsInput,
  base: string,
): Promise<{ ok: true; results: IndexDeal[]; filtersNotApplied: string[] } | { ok: false }> {
  const limit = Math.min(Math.max(Number(input.limit) || 8, 1), 50)
  const setNeedle = input.setName?.trim().toLowerCase() || null
  // Neither source filters on a partial set name, so over-fetch and filter here.
  const fetchN = setNeedle ? Math.min(limit * 3, 50) : limit
  const player = input.player?.trim() || null
  const tier = input.tier?.trim() || null
  const team = input.team?.trim() || null
  const maxPrice = num(input.maxPrice)
  const minDiscount = num(input.minDiscount)
  const hasBadge = input.hasBadge === true
  // A filter the source cannot apply is REPORTED, never silently dropped — an
  // unfiltered list handed back as "badged deals" is a false answer.
  const filtersNotApplied: string[] = []

  const readOne = async (who: string | null, n: number): Promise<any[] | null> => {
    if (collectionId === "nfl-all-day") {
      const res = await supabase.rpc("get_allday_market_editions_v3", {
        p_sort_by: "discount_desc",
        p_limit: n,
        p_player: who,
        p_rarity: tier ? tier.toUpperCase() : "all",
        // v3 matches p_team with a bare ILIKE; wrap it so "Chiefs" finds
        // "Kansas City Chiefs" the way the v1 query's %team% did.
        p_team: team ? `%${team}%` : "all",
        p_max_price: maxPrice != null && maxPrice > 0 ? maxPrice : 0,
        p_min_discount: minDiscount != null && minDiscount > 0 ? minDiscount : 0,
        p_has_badges: hasBadge,
      })
      return res.error ? null : (res.data ?? [])
    }
    const res = await supabase.rpc("get_golazos_catalog_deals", {
      p_player: who,
      p_tier: tier,
      p_team: team,
      p_max_price: maxPrice,
      p_min_discount: minDiscount,
      p_limit: n,
    })
    return res.error ? null : (res.data ?? [])
  }

  if (collectionId === "laliga-golazos" && hasBadge) filtersNotApplied.push("hasBadge")

  let data: any[]
  const labels = (input.labels ?? []).filter((l) => typeof l === "string" && l.trim())
  if (labels.length > 0) {
    // One read per label, over-fetched so a namesake's rows cannot crowd the
    // person's out of the limit, then kept only on an exact label match.
    const reads = await Promise.all(labels.map((l) => readOne(l, Math.min(Math.max(fetchN, limit * 3), 50))))
    if (reads.some((r) => r == null)) return { ok: false }
    const keep = new Set(labels)
    const seen = new Set<string>()
    data = []
    for (const r of reads as any[][]) {
      for (const row of r) {
        if (!keep.has(String(row.player_name ?? ""))) continue
        const k = String(row.external_id ?? row.edition_id)
        if (seen.has(k)) continue
        seen.add(k)
        data.push(row)
      }
    }
    data.sort((a, b) => {
      const da = num(a.fmv_usd) != null && Number(a.fmv_usd) > 0 ? num(a.discount_pct) : null
      const db = num(b.fmv_usd) != null && Number(b.fmv_usd) > 0 ? num(b.discount_pct) : null
      if (da != null && db != null && da !== db) return db - da
      if (da != null && db == null) return -1
      if (da == null && db != null) return 1
      return (num(a.floor_ask) ?? Infinity) - (num(b.floor_ask) ?? Infinity)
    })
  } else {
    const r = await readOne(player, fetchN)
    if (r == null) return { ok: false }
    data = r
  }
  if (setNeedle) data = data.filter((r) => String(r.set_name ?? "").toLowerCase().includes(setNeedle))
  data = data.slice(0, limit)

  // get_allday_market_editions_v3 returns no floor_flow_id (Golazos' RPC does), so
  // until 2026-10-18 every All Day deal reached the model with buy_url null. The
  // listing behind the floor comes from the same edition-keyed floor view the
  // floor search reads (EDITION_FLOOR_VIEW), and is linked ONLY when its ask is the
  // ask this row quotes — a link to a different listing would be a false claim. A
  // failed lookup costs the link, never the row (edition_url still carries it).
  if (collectionId === "nfl-all-day" && data.length > 0) {
    const ids = data.map((r) => r.edition_id).filter((x) => x != null).map(String)
    if (ids.length > 0) {
      const { data: floors, error } = await supabase
        .from(EDITION_FLOOR_VIEW["nfl-all-day"])
        .select("edition_id, floor_ask, floor_flow_id")
        .in("edition_id", ids)
      if (!error) {
        const byId = new Map<string, Record<string, any>>()
        for (const f of (floors ?? []) as Array<Record<string, any>>) byId.set(String(f.edition_id), f)
        data = data.map((r) => {
          const f = byId.get(String(r.edition_id))
          if (!f || f.floor_flow_id == null || r.floor_flow_id != null) return r
          const a = num(f.floor_ask), b = num(r.floor_ask)
          return a != null && b != null && Math.abs(a - b) < 0.005 ? { ...r, floor_flow_id: f.floor_flow_id } : r
        })
      }
    }
  }

  const results: IndexDeal[] = []
  for (const r of data as Array<Record<string, any>>) {
    const price = num(r.floor_ask)
    if (price == null || !(price > 0)) continue
    const fmv = num(r.fmv_usd)
    const priced = fmv != null && fmv > 0
    results.push({
      player: r.player_name ?? null,
      set: r.set_name ?? null,
      tier: r.tier ?? null,
      serial: null,
      price,
      fmv: priced ? fmv : null,
      // v3 labels an unpriced edition 'ASK_ONLY'; that is not an FMV confidence.
      confidence: priced ? (r.confidence ?? null) : null,
      discount_pct: priced ? num(r.discount_pct) : null,
      badges: r.badges ?? null,
      buy_url: r.floor_flow_id != null ? marketplaceMomentUrl(collectionId, String(r.floor_flow_id)) : null,
      edition_url: r.external_id ? absoluteEditionPageUrl(base, collectionId, String(r.external_id)) : null,
    })
  }
  return { ok: true, results, filtersNotApplied }
}
