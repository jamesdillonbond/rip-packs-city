// lib/concierge/search-edition-floors.ts
//
// search_across_collections arm for the collections whose asks live in the
// on-chain listing index (EDITION_FLOOR_VIEW: NFL All Day, LaLiga Golazos).
//
// 2026-10-18: the tool searched v1 `cached_listings` for every Flow collection.
// For All Day and Golazos v1 holds only Flowty's book (108 / 100 rows against
// ~35k / ~4.3k open asks in cached_listings_v2), so "does RPC have Mahomes"
// came back with zero All Day results while 26 Mahomes editions had a live
// floor. This arm resolves the player's editions, then reads the same
// edition-keyed floor view get_edition_listings already trusts.
//
// Three states, never two: a failed editions or floor read is `failed: true`
// (unknown); a player with editions but no open ask is reported as such with
// `editions_matched`, so the model can say "N editions, none listed" instead
// of "RPC doesn't have them".

import type { Collection } from "@/lib/collections"
import { marketplaceMomentUrl } from "@/lib/collections"
import { absoluteEditionPageUrl, discountPct } from "@/lib/concierge/edition-listings"

type Supabase = any

/** Editions resolved per search. `.in()` URL length and the view's per-key
 *  lookup both stay small at this size; a broader name is reported as capped. */
export const EDITION_SEARCH_CAP = 150

export interface EditionFloorResult {
  player: string | null
  set: string | null
  tier: string | null
  /** Edition-level answer: the floor's serial is not carried by the view. */
  serial: null
  price: number
  fmv: number | null
  confidence: string | null
  discount_pct: number | null
  buy_url: string | null
  edition_url: string
  listed_at: string | null
}

export interface EditionFloorGroup {
  collection: string
  collectionId: string
  results: EditionFloorResult[]
  failed?: boolean
  editions_matched?: number
  editions_listed?: number
  note?: string
}

const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function searchEditionFloorsByName(
  supabase: Supabase,
  col: Pick<Collection, "id" | "label">,
  collectionUuid: string,
  floorView: string,
  name: string,
  perCollection: number,
  base: string,
): Promise<EditionFloorGroup> {
  const head = { collection: col.label, collectionId: col.id }

  const { data: eds, error: edErr } = await supabase
    .from("editions")
    .select("id, external_id, player_name, set_name, tier")
    .eq("collection_id", collectionUuid)
    .ilike("player_name", `%${name}%`)
    .order("id", { ascending: true })
    .limit(EDITION_SEARCH_CAP + 1)
  if (edErr) return { ...head, results: [], failed: true }

  const all = (eds ?? []) as Array<Record<string, any>>
  const capped = all.length > EDITION_SEARCH_CAP
  const editions = all.slice(0, EDITION_SEARCH_CAP)
  if (editions.length === 0) return { ...head, results: [], editions_matched: 0 }

  const ids = editions.map((e) => e.id)
  const { data: floors, error: flErr } = await supabase
    .from(floorView)
    .select("edition_id, floor_ask, floor_ask_listed_at, floor_flow_id")
    .in("edition_id", ids)
  // ok means the QUERY succeeded, not that rows came back — a timeout must not
  // become "none of this player's editions are listed".
  if (flErr) return { ...head, results: [], failed: true, editions_matched: editions.length }

  const floorBy = new Map<string, Record<string, any>>()
  for (const f of (floors ?? []) as Array<Record<string, any>>) {
    if (num(f.floor_ask) != null && Number(f.floor_ask) > 0) floorBy.set(String(f.edition_id), f)
  }
  const listed = editions.filter((e) => floorBy.has(String(e.id)))

  // FMV is supplementary: a failed read leaves fmv null, never 0.
  const fmvBy = new Map<string, { fmv: number | null; confidence: string | null }>()
  if (listed.length > 0) {
    try {
      const { data: fm, error: fmErr } = await supabase
        .from("fmv_current")
        .select("edition_id, fmv_usd, confidence")
        .in("edition_id", listed.map((e) => e.id))
      if (!fmErr) {
        for (const r of (fm ?? []) as Array<Record<string, any>>) {
          fmvBy.set(String(r.edition_id), { fmv: num(r.fmv_usd), confidence: r.confidence ?? null })
        }
      }
    } catch { /* fmv stays null */ }
  }

  const results: EditionFloorResult[] = listed.map((e) => {
    const f = floorBy.get(String(e.id))!
    const price = Number(f.floor_ask)
    const fv = fmvBy.get(String(e.id))
    const fmv = fv?.fmv ?? null
    return {
      player: e.player_name ?? null,
      set: e.set_name ?? null,
      tier: e.tier ?? null,
      serial: null,
      price,
      fmv,
      confidence: fv?.confidence ?? null,
      discount_pct: discountPct(price, fmv),
      buy_url: f.floor_flow_id != null ? marketplaceMomentUrl(col.id, String(f.floor_flow_id)) : null,
      edition_url: absoluteEditionPageUrl(base, col.id, String(e.external_id)),
      listed_at: f.floor_ask_listed_at ?? null,
    }
  })

  // Best discount first (the old v1 ordering), then cheapest; an unpriced FMV
  // sorts after every priced one rather than being read as a 0 discount.
  results.sort((a, b) => {
    const da = a.discount_pct, db = b.discount_pct
    if (da != null && db != null && da !== db) return db - da
    if (da != null && db == null) return -1
    if (da == null && db != null) return 1
    return a.price - b.price
  })

  const group: EditionFloorGroup = {
    ...head,
    results: results.slice(0, perCollection),
    editions_matched: editions.length,
    editions_listed: listed.length,
  }
  // A capped search checked only part of the match, so "none listed" would be
  // a claim about editions it never looked at — the cap note wins.
  if (capped) {
    group.note = `The name matched more than ${EDITION_SEARCH_CAP} editions; only the first ${EDITION_SEARCH_CAP} were checked for asks. Suggest a more specific name.`
  } else if (listed.length === 0) {
    group.note = `${editions.length} matching edition(s) exist in ${col.label}, but none has an open ask right now. Say they are not listed — not that RPC doesn't have them.`
  }
  return group
}
