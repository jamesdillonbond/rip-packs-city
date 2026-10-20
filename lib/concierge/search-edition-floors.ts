// lib/concierge/search-edition-floors.ts
//
// search_across_collections arm for the collections whose asks are edition-keyed
// in our own books: the on-chain listing index (EDITION_FLOOR_VIEW: NFL All Day,
// LaLiga Golazos) and Candy MLB's swept Magic Eden / OpenSea book (candy_listings).
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
import { paniniEditionUrl } from "@/lib/panini/edition-url"

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

export interface EditionFloor {
  ask: number
  listedAt: string | null
  buyUrl: string | null
}

/** Reads the lowest live ask per edition. `ok: false` is a FAILED read (or a
 *  book too stale to vouch for absence) — never "nothing listed". */
export type FloorReader = (
  supabase: Supabase,
  editionIds: string[],
) => Promise<{ ok: boolean; floors: Map<string, EditionFloor> }>

/** The edition-keyed floor views (EDITION_FLOOR_VIEW): All Day, Golazos. */
export function viewFloorReader(floorView: string, collectionId: string): FloorReader {
  return async (supabase, ids) => {
    const { data, error } = await supabase
      .from(floorView)
      .select("edition_id, floor_ask, floor_ask_listed_at, floor_flow_id")
      .in("edition_id", ids)
    const floors = new Map<string, EditionFloor>()
    // ok means the QUERY succeeded, not that rows came back — a timeout must not
    // become "none of this player's editions are listed".
    if (error) return { ok: false, floors }
    for (const f of (data ?? []) as Array<Record<string, any>>) {
      const ask = num(f.floor_ask)
      if (ask == null || !(ask > 0)) continue
      floors.set(String(f.edition_id), {
        ask,
        listedAt: f.floor_ask_listed_at ?? null,
        buyUrl: f.floor_flow_id != null ? marketplaceMomentUrl(collectionId, String(f.floor_flow_id)) : null,
      })
    }
    return { ok: true, floors }
  }
}

/** Same freshness rules as get_edition_listings' Candy arm: an ask counts only
 *  if RE-SEEN within the window (Magic Eden asks carry no expiry), and the
 *  Magic Eden book itself must have been swept inside it — otherwise "no fresh
 *  ask" would be a stalled indexer reported as an empty market. */
export const CANDY_ASK_FRESH_MS = 7 * 3600_000

export const candyFloorReader: FloorReader = async (supabase, ids) => {
  const floors = new Map<string, EditionFloor>()
  const since = new Date(Date.now() - CANDY_ASK_FRESH_MS).toISOString()
  // Chunked: PostgREST returns at most 1,000 rows, and the asks are ordered by
  // price, so one read over many editions could cut off every ask of the dearer
  // ones and report them "not listed". A chunk that hits the cap is a failed read.
  const CHUNK = 25
  const ASK_CAP = 1000
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
  const [asksReads, head] = await Promise.all([
    Promise.all(chunks.map((c) =>
      supabase
        .from("candy_listings")
        .select("edition_id, price_usd, token_mint, last_seen_at, venue, venue_url")
        .in("edition_id", c)
        .eq("is_active", true)
        .gt("price_usd", 0)
        .gte("last_seen_at", since)
        .order("price_usd", { ascending: true })
        .limit(ASK_CAP),
    )),
    supabase
      .from("candy_listings")
      .select("last_seen_at")
      .eq("venue", "magic_eden")
      .eq("is_active", true)
      .order("last_seen_at", { ascending: false })
      .limit(1),
  ])
  const newest = (head.data ?? [])[0]?.last_seen_at as string | undefined
  const bookFresh = !!newest && Date.parse(newest) >= Date.parse(since)
  if (head.error || !bookFresh) return { ok: false, floors }
  if (asksReads.some((r: any) => r.error || (r.data ?? []).length >= ASK_CAP)) return { ok: false, floors }
  const asks = { data: asksReads.flatMap((r: any) => r.data ?? []) }
  // Keep the cheapest ask per edition (chunks are each price-ordered).
  for (const r of asks.data as Array<Record<string, any>>) {
    const id = String(r.edition_id)
    const ask = num(r.price_usd)
    if (ask == null || !(ask > 0)) continue
    const prev = floors.get(id)
    if (prev && prev.ask <= ask) continue
    floors.set(id, {
      ask,
      // last_seen_at is when the sweep last SAW the ask, not when it was listed.
      listedAt: null,
      // An OpenSea ask links only to the URL OpenSea returned, never to Magic Eden.
      buyUrl: r.venue === "opensea" ? (r.venue_url || null) : marketplaceMomentUrl("candy-mlb", String(r.token_mint)),
    })
  }
  return { ok: true, floors }
}

/** Panini (2026-10-19): the confirmed ask the edition page shows (panini_market_board) —
 *  the cheapest LISTED serial re-read in the last 7 days. Read from panini_card_serials
 *  directly: the board view filters a multi-key list only AFTER aggregating every serial
 *  (~50k buffers / 220 ms for 50 keys), while the serial index answers 25 keys in ~110.
 *  Same rule as the view, so the two agree. A chunk that hits the row cap is a failed read. */
export const PANINI_ASK_CONFIRMED_DAYS = 7

export const paniniFloorReader: FloorReader = async (supabase, ids) => {
  const floors = new Map<string, EditionFloor>()
  const { data: eds, error: edErr } = await supabase.from("editions").select("id, external_id").in("id", ids)
  if (edErr) return { ok: false, floors }
  const idByKey = new Map<string, string>()
  for (const e of (eds ?? []) as Array<{ id: string; external_id: string }>) idByKey.set(String(e.external_id), String(e.id))
  const keys = [...idByKey.keys()]
  const since = new Date(Date.now() - PANINI_ASK_CONFIRMED_DAYS * 86_400_000).toISOString()
  const CHUNK = 25
  const ROW_CAP = 1000
  const reads = await Promise.all(
    Array.from({ length: Math.ceil(keys.length / CHUNK) }, (_, i) => keys.slice(i * CHUNK, (i + 1) * CHUNK)).map((c) =>
      supabase
        .from("panini_card_serials")
        .select("edition_external_id, price_usd, captured_at")
        .in("edition_external_id", c)
        .eq("is_listed", true)
        .gt("price_usd", 0)
        .gt("captured_at", since)
        .order("price_usd", { ascending: true })
        .limit(ROW_CAP),
    ),
  )
  if (reads.some((r: any) => r.error || (r.data ?? []).length >= ROW_CAP)) return { ok: false, floors }
  for (const r of reads.flatMap((x: any) => x.data ?? []) as Array<Record<string, any>>) {
    const id = idByKey.get(String(r.edition_external_id))
    const ask = num(r.price_usd)
    if (!id || ask == null || !(ask > 0)) continue
    const prev = floors.get(id)
    if (prev && prev.ask <= ask) continue
    floors.set(id, {
      ask,
      // captured_at is when the walk last re-read the serial, not when it was listed.
      listedAt: null,
      buyUrl: paniniEditionUrl(String(r.edition_external_id)),
    })
  }
  return { ok: true, floors }
}

export async function searchEditionFloorsByName(
  supabase: Supabase,
  col: Pick<Collection, "id" | "label">,
  collectionUuid: string,
  floorSource: string | FloorReader,
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
  const reader = typeof floorSource === "string" ? viewFloorReader(floorSource, col.id) : floorSource
  const read = await reader(supabase, ids)
  if (!read.ok) return { ...head, results: [], failed: true, editions_matched: editions.length }
  const floorBy = read.floors
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
    const price = f.ask
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
      buy_url: f.buyUrl,
      edition_url: absoluteEditionPageUrl(base, col.id, String(e.external_id)),
      listed_at: f.listedAt,
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
