// lib/insights/trophies-board.ts
//
// The single query behind the grails/trophies board, shared by BOTH consumers:
// `app/insights/trophies/page.tsx` (server-renders the default view so the
// ranked grails and their drill-down links are crawlable) and
// `app/api/public/insights/trophies/route.ts` (the client's filtered refetches).
//
// Same rationale as lib/insights/allday-scarcity-board.ts — see that file for
// the full "why". Short version: both consumers held their own copy of the
// column list and ordering, so adding a column to one silently diverged the
// server-rendered html from the client's first refetch; and the page's copy sat
// in `app/**/page.tsx`, which NEITHER coverage gate measures.
//
// ⚠ DEFAULTS ARE NOT SHARED. The page pins `limit: 200`; the route defaults to
// 200 but caps at 500 for a direct API caller. This module owns the QUERY.

import { supabaseAdmin } from "@/lib/supabase"
import { PINNACLE_TROPHY_COLLECTION, TROPHY_COLLECTIONS } from "@/lib/insights/trophy-collections"

export { TROPHY_COLLECTIONS }

/** Columns both consumers select. Duplicating this list was the drift risk. */
export const TROPHIES_COLS =
  "edition_id, external_id, collection, collection_id, name, player_name, set_name, team_name, tier, series, circulation_count, thumbnail_url, video_url, is_one_of_one, is_ultimate, is_top_tier, fmv_usd, confidence, fmv_computed_at"

/** Disney Pinnacle's grail editions: a mint of one, or its top edition types. */
const PINNACLE_TOP_EDITION_TYPES = ["Legendary Edition", "Genesis Edition"]
const PINNACLE_COLS =
  "render_id, character_name, characters, set_name, edition_type, total_minted, thumbnail_url, fmv_usd, fmv_computed_at"

export interface TrophiesBoardOptions {
  collection?: string | null
  /** "one_of_one" | "ultimate" (= the collection's TOP tier) | null. */
  type?: string | null
  sort?: string
  limit: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any
type TrophyRow = Record<string, unknown> & { fmv_usd: number | null; circulation_count: number | null }

// FMV-desc (nulls last) is the canonical "headline grails first" ranking, so
// the priced trophies lead and the never-traded grails follow. Both orderings
// carry a tiebreak on purpose: without it two equal-FMV grails order
// arbitrarily and the server html can disagree with the client refetch.
function compare(sort: string) {
  const num = (v: unknown, dflt: number) => (v == null ? dflt : Number(v))
  return (a: TrophyRow, b: TrophyRow) => {
    const fa = num(a.fmv_usd, -Infinity), fb = num(b.fmv_usd, -Infinity)
    const ca = num(a.circulation_count, Infinity), cb = num(b.circulation_count, Infinity)
    return sort === "circulation" ? ca - cb || fb - fa : fb - fa || ca - cb
  }
}

function readEditionsView(db: Db, collection: string | null, type: string | null, sort: string, limit: number) {
  let q = db.from("v_insights_trophies").select(TROPHIES_COLS)
  q = collection
    ? q.eq("collection", collection)
    : q.in("collection", TROPHY_COLLECTIONS.filter((c) => c !== PINNACLE_TROPHY_COLLECTION))
  if (type === "one_of_one") q = q.eq("is_one_of_one", true)
  else if (type === "ultimate") q = q.eq("is_top_tier", true)
  if (sort === "circulation") {
    q = q
      .order("circulation_count", { ascending: true, nullsFirst: false })
      .order("fmv_usd", { ascending: false, nullsFirst: false })
  } else {
    q = q
      .order("fmv_usd", { ascending: false, nullsFirst: false })
      .order("circulation_count", { ascending: true, nullsFirst: false })
  }
  return q.limit(limit)
}

/** Pinnacle pins are catalog renders (render_id), not `editions` rows — mapped
 *  into the board's row shape; the tile links to the pin page by render_id. */
async function readPinnacle(db: Db, type: string | null, sort: string, limit: number) {
  let q = db.from("pinnacle_catalog").select(PINNACLE_COLS).not("thumbnail_url", "is", null)
  // Every Pinnacle 1-of-1 is a Legendary or Genesis edition (17 of 17, 10-18), so
  // the top edition types ARE the grail set; a 1-of-1 pick narrows within them.
  q = q.in("edition_type", PINNACLE_TOP_EDITION_TYPES)
  if (type === "one_of_one") q = q.eq("total_minted", 1)
  if (sort === "circulation") {
    q = q
      .order("total_minted", { ascending: true, nullsFirst: false })
      .order("fmv_usd", { ascending: false, nullsFirst: false })
  } else {
    q = q
      .order("fmv_usd", { ascending: false, nullsFirst: false })
      .order("total_minted", { ascending: true, nullsFirst: false })
  }
  const { data, error } = await q.order("render_id", { ascending: true }).limit(limit)
  if (error) return { data: null, error }
  const rows = ((data ?? []) as Array<Record<string, any>>).map((p) => ({
    edition_id: p.render_id,
    external_id: p.render_id,
    collection: PINNACLE_TROPHY_COLLECTION,
    collection_id: null,
    name: p.character_name ?? null,
    // A character is the `characters` TRAIT, never character_name (the pin's name).
    player_name: Array.isArray(p.characters) && p.characters.length ? p.characters.join(", ") : null,
    set_name: p.set_name ?? null,
    team_name: null,
    tier: p.edition_type ?? null,
    series: null,
    circulation_count: p.total_minted ?? null,
    thumbnail_url: p.thumbnail_url ?? null,
    video_url: null,
    is_one_of_one: p.total_minted === 1,
    is_ultimate: false,
    is_top_tier: PINNACLE_TOP_EDITION_TYPES.includes(p.edition_type),
    fmv_usd: p.fmv_usd ?? null,
    confidence: null,
    fmv_computed_at: p.fmv_computed_at ?? null,
  }))
  return { data: rows, error: null }
}

/** Returns `{ data, error }` so each caller keeps its own failure policy
 * (503-without-leak for the route, `ok:false` for the page). Either source
 * failing is an error — never a shorter list read as the whole board. */
export async function fetchTrophiesBoard(
  opts: TrophiesBoardOptions,
  db: Db = supabaseAdmin,
): Promise<{ data: unknown[] | null; error: { message: string } | null }> {
  const { collection = null, type = null, sort = "fmv", limit } = opts
  if (collection === PINNACLE_TROPHY_COLLECTION) return readPinnacle(db, type, sort, limit)
  if (collection) return readEditionsView(db, collection, type, sort, limit)
  const [ed, pin] = await Promise.all([readEditionsView(db, null, type, sort, limit), readPinnacle(db, type, sort, limit)])
  const error = ed.error ?? pin.error
  if (error) return { data: null, error }
  // Both legs are each the top `limit` by the same order, so the merge's top
  // `limit` is the true top `limit`.
  const merged = ([...(ed.data ?? []), ...(pin.data ?? [])] as TrophyRow[]).sort(compare(sort)).slice(0, limit)
  return { data: merged, error: null }
}
