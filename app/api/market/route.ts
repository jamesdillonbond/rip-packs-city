// app/api/market/route.ts
//
// Phase 4 — Market browser API.
//
// Collection-aware listing feed pulled from cached_listings (which is already
// fully denormalized — player_name, team_name, set_name, tier, serial_number,
// ask_price, fmv, thumbnail_url, badge_slugs live on the row). Replaces the
// old NBA-only badge_editions version.
//
// Phase 4 additions:
//   - team (multi-select)
//   - badges (multi-select; intersects cached_listings.badge_slugs)
//   - specialSerials toggle (#1, last-serial)
//   - per-row editionKey derived via editions JOIN on (player_name, set_name)
//     so the client can join against /api/wallet/edition-counts for the
//     "Edition Owned / Locked" column. TS uses set_id_onchain:play_id_onchain
//     (matches the integer form in wallet_moments_cache); other collections
//     use editions.external_id (already the canonical wmc edition_key shape).
//
// Outlier clamp:
//   cached_listings on thin-volume collections (notably LaLiga Golazos) gets
//   polluted by $1M sentinel ask prices — real user listings priced against
//   an unattainable floor to troll or reserve. We apply hard tier-based
//   ceilings server-side to every collection, not just Golazos, since these
//   leak into every feed. Ceilings follow the Phase 3 spec: Common < $500,
//   Rare < $50K, Legendary < $250K, Ultimate < $1M. Fandom/Uncommon/Contender
//   follow their nearest analog (< $500 / < $50K).
//
// Pagination:
//   Server-side via range(). Max 1000 rows per query, default page size 50.
//   Response includes { total, page, hasMore } so the client doesn't have to
//   eat a 1000-row payload for UI-side paging.

import { fmvCannotAnchorDiscount } from "@/lib/sniper/fmv-staleness";
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { loadTopshotFmvGuard, guardTopshotFmv, type FmvGuardMap } from "@/lib/fmv-display-guard"
import { apiErrorResponse } from "@/lib/api-error"
import { readPaniniCoverage } from "@/lib/panini/coverage"
import { boundedRead } from "@/lib/api/bounded-read"
import { getCollectionUuid } from "@/lib/collections"

export const dynamic = "force-dynamic"
// AllDay's get_allday_market_listings was rewritten for LIMIT-pushdown (~62ms), but
// the TS leg (get_topshot_sniper_deals) still evaluates a per-edition FMV lateral for
// its ~3k badge_editions rows to rank by discount (~12s cold, ~2s warm) — that sort is
// fundamental to the deal feed and the RPC is shared with /api/sniper-feed, so it is
// left as-is. 10s was below its cold latency and 504'd; 30 fits under service_role's
// 30s DB statement_timeout while the s-maxage=90 CDN cache absorbs cold hits.
export const maxDuration = 30

const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

// Tier ceilings — ask prices above these are treated as sentinels and dropped.
// Keys are upper-cased raw tier strings as stored in cached_listings.tier.
const TIER_CEILING: Record<string, number> = {
  COMMON:     500,
  FANDOM:     500,
  UNCOMMON:   500,
  CONTENDER:  500,
  RARE:       50_000,
  CHALLENGER: 50_000,
  LEGENDARY:  250_000,
  CHAMPION:   250_000,
  ULTIMATE:   1_000_000,
}

// Absolute maximum across all tiers. Anything past this is always a sentinel.
const ABSOLUTE_CEILING = 1_000_000

const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 50

type SortKey =
  | "price_asc" | "price_desc"
  | "discount_asc" | "discount_desc"
  | "fmv_asc" | "fmv_desc"
  | "recent"

const ALLOWED_SORTS: Set<SortKey> = new Set([
  "price_asc", "price_desc",
  "discount_asc", "discount_desc",
  "fmv_asc", "fmv_desc",
  "recent",
])

function computeDiscount(ask: number | null, fmv: number | null): number | null {
  if (ask == null || fmv == null || fmv <= 0) return null
  return Math.round(((fmv - ask) / fmv) * 1000) / 10
}

function normJoinKey(player: string | null | undefined, set: string | null | undefined): string | null {
  if (!player || !set) return null
  return `${String(player).trim().toLowerCase()}|${String(set).trim().toLowerCase()}`
}

// Collapse per-listing (serial-grain) enriched rows into one row per edition
// (Trevor's Market=edition / Sniper=serial split). Used on the legacy
// cached_listings path (Golazos / UFC — tiny feeds where an in-memory group-by
// is fine; AllDay/TS/Pinnacle aggregate at their source instead). Floor ask =
// the group's minimum ask, listedCount = the group size, discount recomputed off
// the floor. Per-serial affordances (serial, single-moment buy link) are dropped
// — those belong on Sniper.
function collapseToEditions(rows: any[]): any[] {
  const groups = new Map<string, any[]>()
  for (const r of rows) {
    const key: string =
      r.editionKey ||
      (r.playerName && r.setName
        ? `${String(r.playerName).toLowerCase().trim()}|${String(r.setName).toLowerCase().trim()}|${String(r.tier ?? "").toLowerCase()}`
        : String(r.id))
    const g = groups.get(key)
    if (g) g.push(r)
    else groups.set(key, [r])
  }
  const out: any[] = []
  for (const g of groups.values()) {
    let rep = g[0]
    let floor: number | null = rep.askPrice
    let fmv: number | null = null
    let listedAt: string | null = rep.listedAt
    for (const r of g) {
      if (r.askPrice != null && (floor == null || r.askPrice < floor)) { floor = r.askPrice; rep = r }
      if (r.fmv != null && (fmv == null || r.fmv > fmv)) fmv = r.fmv
      if (r.listedAt && (!listedAt || Date.parse(r.listedAt) > Date.parse(listedAt))) listedAt = r.listedAt
    }
    out.push({
      ...rep,
      askPrice: floor,
      fmv,
      discount: computeDiscount(floor, fmv),
      listedCount: g.length,
      serialNumber: null,
      // Carry the REPRESENTATIVE (floor-ask) listing's special-serial flag, so
      // ?specialSerials=true means the same thing here as on the modern path:
      // "this edition's headline listing is a #1 or a perfect (#N/N) mint".
      // Before 2026-08-02 this was hardcoded false while the specialSerials
      // predicate ran AFTER the collapse, so the filter could only ever return
      // an EMPTY board on this path (Golazos / UFC). serialNumber stays null —
      // Market is edition-grain and the per-serial affordances still belong on
      // Sniper; this is a flag, not a serial.
      isSpecialSerial: !!rep.isSpecialSerial,
      flowId: null,   // no single on-chain moment at edition grain
      buyUrl: null,   // per-serial listing link belongs on Sniper
      listedAt,
    })
  }
  return out
}

interface EditionRow {
  external_id: string | null
  collection_id: string
  player_name: string | null
  set_name: string | null
  set_id_onchain: number | null
  play_id_onchain: number | null
  badges: string[] | null
}

// Per-collection edition-metadata lookup, keyed by normJoinKey(player, set). It
// backfills the on-chain edition key (TS integer form) + edition-wide badges
// onto market rows that don't carry their own (TS sniper rows arrive with
// edition_key/badge_slugs null — for them this lookup is load-bearing).
//
// PostgREST caps an unbounded select at 1,000 rows, so the old bare .limit(50000)
// silently returned only 1,000 of a collection's editions (TS has ~19k, AllDay
// ~6k) and left most rows un-enriched (null edition links, no badges). The whole
// catalog is now paged in with .range(). The completed map is memoized per
// collection (10-min TTL) so a hot Market surface doesn't rebuild it every
// request — net FEWER queries than the old one-per-request fetch. A partial map
// from a mid-page error is returned but NOT cached, so the next request retries.
const editionLookupCache = new Map<string, { expiresAt: number; map: Map<string, EditionRow> }>()
const EDITION_LOOKUP_TTL_MS = 10 * 60 * 1000
// Disabled under test so each case rebuilds from its own mock (no cross-case bleed).
const EDITION_LOOKUP_MEMO = process.env.NODE_ENV !== "test"

async function loadEditionLookup(collectionId: string): Promise<Map<string, EditionRow>> {
  const nowMs = Date.now()
  if (EDITION_LOOKUP_MEMO) {
    const cached = editionLookupCache.get(collectionId)
    if (cached && cached.expiresAt > nowMs) return cached.map
  }
  const map = new Map<string, EditionRow>()
  const PAGE = 1000
  let complete = true
  try {
    for (let from = 0; from < 60_000; from += PAGE) {
      const { data, error } = await boundedRead((supabaseAdmin as any)
        .from("editions")
        .select("external_id, collection_id, player_name, set_name, set_id_onchain, play_id_onchain, badges")
        .eq("collection_id", collectionId)
        .order("external_id", { ascending: true })
        .range(from, from + PAGE - 1), "api/market/editions")
      if (error) {
        console.log("[/api/market] editions lookup error: " + error.message)
        complete = false
        break
      }
      const rows = (data ?? []) as EditionRow[]
      for (const r of rows) {
        const k = normJoinKey(r.player_name, r.set_name)
        if (!k) continue
        // Keep the most-resolved row when collisions happen — prefer the one
        // with both onchain ids populated.
        const existing = map.get(k)
        const incomingOnchain = r.set_id_onchain != null && r.play_id_onchain != null
        const existingOnchain = existing && existing.set_id_onchain != null && existing.play_id_onchain != null
        if (!existing || (incomingOnchain && !existingOnchain)) map.set(k, r)
      }
      if (rows.length < PAGE) break
    }
  } catch (err) {
    console.log("[/api/market] editions lookup threw: " + (err instanceof Error ? err.message : String(err)))
    complete = false
  }
  if (EDITION_LOOKUP_MEMO && complete) {
    editionLookupCache.set(collectionId, { expiresAt: nowMs + EDITION_LOOKUP_TTL_MS, map })
  }
  return map
}


// ── Modern listings helper (Phase 3.5, 2026-05-26) ──────────────────────────
// The legacy `cached_listings` table the route below reads from is post-Flowty-
// teardown dead for TS (0 rows) and stale for AllDay (~2 weeks). Modern data
// lives in `badge_editions` (TS) and `cached_listings_v2` (AllDay/Golazos/UFC).
// This helper dispatches to the same sniper RPCs the /api/sniper-feed route
// uses and emits rows in the legacy cached_listings response shape so the
// downstream clamp / discount / sort / paginate logic stays untouched.

const TS_COLLECTION_ID_FOR_DISPATCH = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ALLDAY_COLLECTION_ID_FOR_DISPATCH = "dee28451-5d62-409e-a1ad-a83f763ac070"
const PINNACLE_COLLECTION_ID_FOR_DISPATCH = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const CANDY_COLLECTION_ID_FOR_DISPATCH = "209ade70-32c5-4470-bc7c-4793d660f713"
const PANINI_COLLECTION_ID_FOR_DISPATCH = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"

// Pinnacle Market source (edition-level, 2026-07-18). Trevor's Market=edition /
// Sniper=serial split: Market shows ONE row per Pinnacle render (= edition) with
// its aggregate market, not individual listed pins. `pinnacle_catalog` is the
// canonical render-grain table and already carries a fresh, direct-chain
// (studio-platform-gql) `floor_ask` per render plus render-keyed FMV — a far more
// complete edition-grain source (~2,095 priced renders) than the live-Flowty
// sniper feed (capped ~96 listed NFTs). We read it directly and reshape into the
// legacy cached_listings row shape so the downstream clamp / discount / sort /
// paginate pipeline stays untouched. editionKey = render_id (the
// /disney-pinnacle/edition/<render_id> route redirects to /pinnacle/moment/<id>).
async function fetchPinnacleModernListings(
  collectionId: string,
  filters: {
    tier: string
    maxPrice: number
    sortBy: string
    // 🚨 ADDED 2026-09-20. These four were parsed from the query string and then
    // applied ONLY in the legacy `cached_listings` fall-through below — which a
    // modern arm never reaches. So Set / Series / Character / Min-price were
    // silently DROPPED here while the UI showed them as active filters.
    //
    // Measured on production before fixing: asking Pinnacle for
    // `set=Pixar Animation Studios • Toy Story Vol.1` returned rows from Beauty
    // and the Beast, Star Wars Alphabet, The Jungle Book and Cats & Dogs — not
    // one row from the requested set, `diagnostics.source: "modern"`.
    // ⚠ The same probe on Top Shot (`set=Base Set`) returned "WNBA Base Set" and
    // "Archive Set 2014-19", so this is NOT Pinnacle-specific; the Top Shot and
    // All Day arms are RPCs and need their own fix (known-issues).
    sets: string[]
    seriesList: string[]
    player: string
    minPrice: number
  },
): Promise<any[] | null> {
  try {
    const s = filters.sortBy
    const build = () => {
    let q = (supabaseAdmin as any)
      .from("pinnacle_catalog")
      .select("render_id, character_name, set_name, series_name, variant, total_minted, floor_ask, fmv_usd, fmv_confidence, thumbnail_url, floor_ask_updated_at")
      .not("floor_ask", "is", null)
      .gt("floor_ask", 0)
      // Only surface renders whose floor is currently maintained — a stale floor
      // whose listing has since been pulled shouldn't render as a live market row.
      .gte("floor_ask_updated_at", new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString())
    if (filters.maxPrice > 0) q = q.lte("floor_ask", filters.maxPrice)
    // ⚠ `ilike %name%` and NOT `.in("set_name", …)`. `pinnacle_catalog.set_name`
    // carries stray leading/trailing whitespace on 22 of its 169 distinct names
    // (" Lucasfilm Ltd. • Star Wars Alphabet Vol.1", "… Mandalorian Vol.1 "),
    // while the row this API returns — and therefore the value the UI sends
    // back as a filter — is TRIMMED. An equality filter would silently match
    // nothing for those 22 and render as "no listings in this set".
    //
    // ⛔ A substring pattern can over-match ("Vol.1" inside a future "Vol.10"),
    // so the DB filter only NARROWS and the exact trim-equality pass below
    // decides. Measured today: 169 trimmed names, 0 substring collisions — but
    // that is a dated sample, and the in-memory pass is what makes it safe
    // regardless.
    q = applyBrowseFilters(q, { set: "set_name", player: "character_name", price: "floor_ask", series: "series_name" }, filters)
    // PostgREST hard-caps reads at 1,000 rows, so order the fetch by the SAME
    // dimension the UI sort leads with — otherwise a fixed cheapest-first window
    // would hide the expensive renders under "Price ↓" / "FMV ↓". Final ordering
    // is still applied authoritatively in-memory downstream.
    if (s === "price_desc") q = q.order("floor_ask", { ascending: false, nullsFirst: false })
    else if (s === "fmv_desc") q = q.order("fmv_usd", { ascending: false, nullsFirst: false })
    else if (s === "fmv_asc") q = q.order("fmv_usd", { ascending: true, nullsFirst: false })
    else if (s === "recent" || s === "listed_desc") q = q.order("floor_ask_updated_at", { ascending: false, nullsFirst: false })
    else q = q.order("floor_ask", { ascending: true, nullsFirst: false }) // price_asc + discount (computed downstream)
    // Deterministic tiebreak on the table's unique key (paging needs it).
    return q.order("render_id", { ascending: true })
    }

    // ⚠ DISCOUNT SORTS READ THE WHOLE LIVE CATALOG (#146 (1), 2026-09-26).
    // pinnacle_catalog has no discount column to order by, so a discount sort
    // took the 1,000 CHEAPEST renders and ranked those — 1,357 of the 2,357 live
    // renders (measured) could never appear under "Discount ↓/↑". The live
    // population is small enough to page in full; the downstream mapper
    // computes discount and sorts authoritatively.
    // ⛔ A failed read returns NULL, never [] — cached_listings holds ZERO
    // Pinnacle rows, so [] fell through to a confident "no listings".
    const discountSort = s === "discount_desc" || s === "discount_asc"
    const PAGE = 1000
    const MAX_PAGES = discountSort ? 10 : 1
    const data: any[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data: rows, error } = await boundedRead(
        build().range(page * PAGE, page * PAGE + PAGE - 1),
        "api/market/pinnacle_catalog",
      )
      if (error) {
        console.log("[/api/market] pinnacle catalog fetch err:", error.message ?? String(error))
        return null
      }
      data.push(...(rows ?? []))
      if ((rows?.length ?? 0) < PAGE) break
      // A discount sort that fills every page is a PARTIAL population ranked as
      // if whole — refuse it rather than publish it (4× today's live count).
      if (discountSort && page === MAX_PAGES - 1) {
        console.log(`[/api/market] pinnacle catalog exceeded ${MAX_PAGES * PAGE} rows under a discount sort — refusing a partial ranking`)
        return null
      }
    }
    // EXACT pass. The DB filters above narrow; these decide, on the same
    // trimmed value the caller sent. Multi-select sets are handled here rather
    // than in the query because PostgREST cannot express "trim(col) IN (…)".
    const rows: any[] = exactSetMatch(data ?? [], filters.sets, "set_name")
    return rows.map((r: any) => ({
      id: `pinnacle:${r.render_id}`,
      flow_id: null,                 // edition-grain row — no single on-chain moment
      moment_id: null,
      edition_key: r.render_id,      // canonical Pinnacle edition key
      player_name: r.character_name ?? null,
      team_name: null,
      set_name: r.set_name != null ? String(r.set_name).trim() : null,
      series_name: r.series_name ?? null,
      tier: r.variant ?? null,       // Pinnacle variant type (Standard / Colored Enamel / …)
      serial_number: null,
      circulation_count: r.total_minted != null ? Number(r.total_minted) : null,
      ask_price: r.floor_ask != null ? Number(r.floor_ask) : null,
      fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
      adjusted_fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
      discount: null,                // recomputed downstream from floor vs fmv
      confidence: r.fmv_confidence ?? null,
      source: "pinnacle",
      buy_url: null,
      thumbnail_url: r.thumbnail_url ?? null,
      badge_slugs: null,             // Pinnacle has no edition-wide badges
      listed_count: null,            // catalog floor is a floor, not a live-count
      listing_resource_id: null,
      storefront_address: null,
      is_locked: false,
      raw_data: null,
      listed_at: r.floor_ask_updated_at ?? null,
      cached_at: r.floor_ask_updated_at ?? null,
      collection_id: collectionId,
    }))
  } catch (err) {
    console.log("[/api/market] pinnacle catalog fetch threw:", err instanceof Error ? err.message : String(err))
    return null
  }
}

// AllDay Market source (edition-level, 2026-07-18). Same Market=edition split:
// one row per AllDay edition with an active listing, carrying floor ask, live
// listed-count, edition-wide badges, and render-keyed FMV. Backed by the
// service-role-only get_allday_market_editions RPC (aggregates 80k+ active
// cached_listings_v2 rows in SQL — grouping the 500-capped per-listing feed
// in-route would miss floors for ~90% of editions). editionKey = external_id
// (the canonical wmc edition_key shape for AllDay).
async function fetchAllDayMarketEditions(
  filters: {
    tier: string; team: string; maxPrice: number; sortBy: string; limit: number
    sets: string[]; seriesList: string[]; player: string; minPrice: number
  },
): Promise<any[]> {
  let rpcSort: string
  if (filters.sortBy === "recent" || filters.sortBy === "listed_desc") rpcSort = "listed_desc"
  else if (filters.sortBy.startsWith("price")) rpcSort = filters.sortBy
  else if (filters.sortBy === "fmv_desc") rpcSort = "fmv_desc"
  else if (filters.sortBy === "discount_desc") rpcSort = "discount_desc"
  // #146 (1), 2026-09-26: the ascending keys have their own ORDER BY branches
  // (migration audit_20260926_market_rpcs_take_fmv_asc_and_discount_asc). They
  // used to fall to listed_desc, so the window was cut by the wrong key.
  else if (filters.sortBy === "fmv_asc") rpcSort = "fmv_asc"
  else if (filters.sortBy === "discount_asc") rpcSort = "discount_asc"
  else rpcSort = "listed_desc"

  const { data, error } = await boundedRead((supabaseAdmin as any).rpc("get_allday_market_editions", {
    p_min_discount: 0,
    p_max_price: filters.maxPrice > 0 ? filters.maxPrice : 0,
    p_rarity: filters.tier && filters.tier !== "all" ? filters.tier : "all",
    p_team: filters.team && filters.team !== "all" ? filters.team : "all",
    p_sort_by: rpcSort,
    p_limit: Math.max(filters.limit, 500),
    ...rpcBrowseFilterArgs(filters),
  }), "api/market/get_allday_market_editions")
  if (error) {
    console.log("[/api/market] allday editions fetch err:", error.message)
    return []
  }
  return (data ?? []).map((r: any) => ({
    id: `allday-ed:${r.external_id ?? r.edition_id}`,
    flow_id: null,                 // edition-grain — no single moment / per-serial listing
    moment_id: null,
    edition_key: r.external_id ?? null,
    player_name: r.player_name ?? null,
    team_name: r.team_name ?? null,
    set_name: r.set_name ?? null,
    series_name: r.series_name ?? null,
    tier: r.tier ? String(r.tier).replace("MOMENT_TIER_", "") : null,
    serial_number: null,
    circulation_count: r.circulation_count != null ? Number(r.circulation_count) : null,
    ask_price: r.floor_ask != null ? Number(r.floor_ask) : null,
    fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
    adjusted_fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
    discount: r.discount_pct != null ? Number(r.discount_pct) : null,
    confidence: r.confidence ?? null,
    source: "allday",
    buy_url: null,
    thumbnail_url: r.thumbnail_url ?? null,
    badge_slugs: Array.isArray(r.badges) ? r.badges : null,   // edition-wide badges from the RPC
    listed_count: r.listed_count != null ? Number(r.listed_count) : null,
    listing_resource_id: null,
    storefront_address: null,
    is_locked: false,
    raw_data: null,
    listed_at: r.last_listed_at ?? null,
    cached_at: r.last_listed_at ?? null,
    collection_id: ALLDAY_COLLECTION_ID_FOR_DISPATCH,
  }))
}

/** The browse filters as RPC arguments, for the two arms served by an RPC
 *  (`get_topshot_sniper_deals`, `get_allday_market_editions`, migration
 *  `audit_20260923_market_rpcs_take_the_browse_filters`). The RPC applies them
 *  BEFORE its LIMIT, which is the only place they can be honest (register #129).
 *
 * ⚠ A key is sent ONLY when its filter is set, so an unfiltered request makes
 * exactly the call it always made — nothing new can fail on the default path.
 * Sets are sent trimmed; the RPC compares them to a trimmed `set_name`. */
function rpcBrowseFilterArgs(f: {
  sets: string[]; seriesList: string[]; player: string; minPrice: number
}): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const sets = f.sets.map((x) => x.trim()).filter(Boolean)
  if (sets.length > 0) args.p_sets = sets
  if (f.seriesList.length > 0) args.p_series = f.seriesList
  if (f.player) args.p_player = f.player
  if (f.minPrice > 0) args.p_min_price = f.minPrice
  return args
}

/** The browse filters the modern arms used to DROP (register #129), applied to a
 *  PostgREST query over whatever this arm's columns happen to be called.
 *
 * 🚨 ONE IMPLEMENTATION, DELIBERATELY. The Pinnacle and Candy arms need the same
 * four filters against different column names (`character_name` vs
 * `player_name`, `floor_ask` vs `ask_usd`), and CLAUDE.md's rule for exactly
 * this shape is that a second copy drifts — it has cost this repo five times.
 * Add an arm by passing its column map, never by pasting the body.
 *
 * ⚠ THE SET FILTER ONLY NARROWS. A `%name%` pattern is used because a stored
 * name may carry stray leading/trailing whitespace while the row this API
 * returns — and therefore the value the UI sends back — is TRIMMED, so equality
 * would match NOTHING for those rows and render as "no listings in this set"
 * (22 of Pinnacle's 169 names are like this). A pattern can over-match, so
 * `exactSetMatch` below DECIDES. Never use one without the other.
 */
function applyBrowseFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  q: any,
  cols: { set: string; player: string; price: string; series?: string },
  f: { sets: string[]; seriesList: string[]; player: string; minPrice: number },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (f.minPrice > 0) q = q.gte(cols.price, f.minPrice)
  // A single set can be narrowed in the DB; a multi-select cannot, because
  // PostgREST has no "trim(col) IN (…)". Both are settled by exactSetMatch.
  if (f.sets.length === 1) q = q.ilike(cols.set, `%${f.sets[0]}%`)
  if (f.player) q = q.ilike(cols.player, `%${f.player}%`)
  if (cols.series && f.seriesList.length > 0) q = q.in(cols.series, f.seriesList)
  return q
}

/** The EXACT half of the set filter — compares on the same trimmed value the
 *  caller sent, so a substring over-match ("Vol.1" inside "Vol.10") is dropped. */
function exactSetMatch<T extends Record<string, unknown>>(
  rows: T[],
  sets: string[],
  setCol: string,
): T[] {
  if (sets.length === 0) return rows
  const want = new Set(sets.map((x) => x.trim()))
  return rows.filter((r) => want.has(String(r[setCol] ?? "").trim()))
}

// Candy MLB (Solana / Metaplex Core) — the ONLY non-Flow arm in this route.
//
// ⚠ THE REST OF THIS FILE IS FLOW-SHAPED, and Candy has none of the Flow
// furniture: no `flow_id`, no listing resource id, no storefront address, no
// lock. Those fields are emitted as NULL rather than filled with a plausible
// stand-in — `token_mint` is the Solana per-serial identity and putting it in
// `flow_id` would make a Solana mint address flow into every downstream reader
// that believes that column names a Flow NFT.
//
// ⚠ SOURCE IS candy_market_board, NOT candy_deals_board. The deals view keeps
// only listings priced below BOTH FMV and the median sale — measured
// 2026-09-12, 233 of the 1,821 active listings. Browsing a market through a
// deals filter would publish "the Candy market" about 13% of it with the
// expensive 87% silently gone, and nothing on the page would say so.
//
// ⚠ CANDY IS MAGIC EDEN ONLY, and `source` says so literally rather than
// implying a venue set. Census of the 1,821 active listings on 2026-09-12:
// ALL of them sit at one auction house (E8cU1WiRW…fkgUWe, Magic Eden v2). Candy
// became an OpenSea Solana launch partner on 2026-08-31, but nothing in the
// ingest can currently detect a second venue, so the honest label is the one
// venue we can actually observe. See docs/reference/chain-strategy.md.
async function fetchCandyMarketListings(
  filters: {
    tier: string; maxPrice: number; sortBy: string; limit: number
    // Register #129 — dropped here too until 2026-09-20. ⓘ Candy's Set chip was
    // the harmless one: `candy_market_board` carries exactly ONE distinct
    // set_name over 2,144 rows, so filtering by it returned everything, which
    // happened to be right. The Player typeahead and Min price were NOT
    // harmless. ⚠ No `series_name` column exists on this board, so no series
    // filter is offered — the chip has no options to build from, which is the
    // honest outcome rather than a silent no-op.
    sets: string[]; seriesList: string[]; player: string; minPrice: number
  }
): Promise<any[] | null> {
  let q = (supabaseAdmin as any)
    .from("candy_market_board")
    .select(
      "token_mint, edition_id, external_id, player_name, edition_name, set_name, team_name, tier, circulation_count, thumbnail_url, serial_number, ask_usd, fmv_usd, confidence, discount_pct, seller, first_seen_at, last_seen_at"
    )
  if (filters.tier && filters.tier !== "all") q = q.eq("tier", filters.tier.toUpperCase())
  if (filters.maxPrice > 0) q = q.lte("ask_usd", filters.maxPrice)
  q = applyBrowseFilters(q, { set: "set_name", player: "player_name", price: "ask_usd" }, filters)

  // Sort is pushed to Postgres so the limit below takes the RIGHT rows, not an
  // arbitrary 500 that the client then sorts into a wrong answer.
  if (filters.sortBy === "price_desc") q = q.order("ask_usd", { ascending: false })
  else if (filters.sortBy === "fmv_desc") q = q.order("fmv_usd", { ascending: false, nullsFirst: false })
  else if (filters.sortBy === "discount_desc") q = q.order("discount_pct", { ascending: false, nullsFirst: false })
  // "FMV ↑" / "Discount ↑" used to fall to ask ascending, so the 500-row window
  // was the 500 cheapest listings (of ~1,900) re-sorted — not the market's lowest
  // FMV or smallest discount (#146 (1), 2026-09-26).
  else if (filters.sortBy === "fmv_asc") q = q.order("fmv_usd", { ascending: true, nullsFirst: false })
  else if (filters.sortBy === "discount_asc") q = q.order("discount_pct", { ascending: true, nullsFirst: false })
  else if (filters.sortBy === "recent" || filters.sortBy === "listed_desc") q = q.order("first_seen_at", { ascending: false, nullsFirst: false })
  else q = q.order("ask_usd", { ascending: true })

  const { data, error } = await boundedRead(q.limit(Math.max(filters.limit, 500)), "api/market/candy_market_board")
  if (error) {
    console.log("[/api/market] candy fetch err:", error.message)
    // ⚠ null, NOT []. An empty array reads as "the Candy market is empty" and
    // falls through to the legacy cached_listings query, which holds no Candy
    // rows at all — so a failed read would render as a confidently empty market.
    return null
  }

  // The exact half of the set filter — see applyBrowseFilters. A no-op when no
  // set was requested, and the only thing that makes the `%name%` narrowing safe.
  // ⚠ Compares `set_name`, which is what the row below reports as `setName`
  // (its `?? edition_name` fallback is a DISPLAY fallback and must not become a
  // second thing the filter matches on — that would let an edition name satisfy
  // a set filter).
  const rows = exactSetMatch(data ?? [], filters.sets, "set_name")

  // Candy's edition designations (Rookie / First Mint, from Candy's published
  // checklist — lib/chains/solana/candy-checklist.ts) ride editions.badges, which
  // candy_market_board does not carry. One extra read for the editions on this
  // page. The Rainbow colour is NOT repeated here: it is the parallel, which the
  // row already names. A failed read degrades to NO badges — an absence, never a
  // claim — and never fails the market read.
  const badgesByEdition = new Map<string, string[]>()
  const editionIds = [...new Set(rows.map((r: any) => r.edition_id).filter(Boolean))]
  if (editionIds.length > 0) {
    const { data: eds, error: edErr } = await boundedRead(
      (supabaseAdmin as any).from("editions").select("id, badges").in("id", editionIds),
      "api/market/candy_edition_badges",
    )
    if (edErr) console.log("[/api/market] candy badges read err:", edErr.message)
    for (const e of (eds ?? []) as { id: string; badges: string[] | null }[]) {
      const b = (e.badges ?? []).filter((t) => typeof t === "string" && !/^Rainbow \(/.test(t))
      if (b.length) badgesByEdition.set(e.id, b)
    }
  }

  return rows.map((r: any) => ({
    id: r.token_mint ?? `${CANDY_COLLECTION_ID_FOR_DISPATCH}:${r.edition_id}`,
    flow_id: null,
    moment_id: r.token_mint ?? null,
    // ⛔ The row's OWN edition key (2026-09-25). Without it the shared mapper falls
    // back to a player+set lookup, and every Candy printing of a player shares
    // both — the lookup keeps the base card, so a Mike Trout PINK listing linked to
    // /candy-mlb/edition/mike-trout and showed the base card's edition stats.
    edition_key: r.external_id ?? null,
    player_name: r.player_name ?? null,
    team_name: r.team_name ?? null,
    set_name: r.set_name ?? r.edition_name ?? null,
    series_name: null,
    tier: r.tier ? String(r.tier).toUpperCase() : null,
    subedition_name: null,
    serial_number: r.serial_number ?? null,
    circulation_count: r.circulation_count ?? null,
    ask_price: r.ask_usd != null ? Number(r.ask_usd) : null,
    fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
    adjusted_fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
    discount: r.discount_pct != null ? Number(r.discount_pct) : null,
    confidence: r.confidence ?? null,
    source: "magic_eden",
    buy_url: r.token_mint ? `https://magiceden.io/item-details/${r.token_mint}` : null,
    thumbnail_url: r.thumbnail_url ?? null,
    badge_slugs: badgesByEdition.get(r.edition_id) ?? null,
    listing_resource_id: null,
    storefront_address: null,
    is_locked: false,
    raw_data: null,
    listed_at: r.first_seen_at ?? null,
    cached_at: r.last_seen_at ?? null,
    collection_id: CANDY_COLLECTION_ID_FOR_DISPATCH,
  }))
}

// ── Panini Market source (2026-09-25, published with Overview + Market) ──────
// `panini_market_board` (migration 20260926041904): one row per bridged Panini
// edition with at least one ask CONFIRMED by a walk in the last 7 days — lowest
// ask, listed-serial count, when it was last confirmed, and the edition's FMV
// from edition_fmv_current. Edition grain, like All Day and Pinnacle.
//
// ⚠ LISTING-GATED BY CONSTRUCTION: Panini publishes no checklist, so a card
// exists to RPC only once it has been listed. The response carries `coverage`
// (panini_coverage_summary) and the Market tab renders it beside the rows.
//
// ⚠ PANINI IS NOT A CHAIN WITH WALLETS, and the Flow furniture is NULL rather
// than filled with a stand-in: no flow_id, no moment id, no storefront, no lock.
// `buy_url` is the edition's page on Panini's own marketplace, where the psku
// (`external_id`) is the recorded identifier the ingest walk itself navigates to.
async function fetchPaniniMarketListings(
  filters: {
    tier: string; maxPrice: number; sortBy: string; limit: number
    sets: string[]; seriesList: string[]; player: string; minPrice: number
  }
): Promise<any[] | null> {
  const window = Math.max(filters.limit, 500)
  const build = () => {
    const q = (supabaseAdmin as any)
      .from("panini_market_board")
      .select(
        "external_id, player_name, set_name, tier, circulation_count, thumbnail_url, low_ask_usd, listed_count, ask_confirmed_at, fmv_usd, confidence, discount_pct"
      )
    let f = q
    if (filters.tier && filters.tier !== "all") f = f.eq("tier", filters.tier.toUpperCase())
    if (filters.maxPrice > 0) f = f.lte("low_ask_usd", filters.maxPrice)
    return applyBrowseFilters(f, { set: "set_name", player: "player_name", price: "low_ask_usd" }, filters)
  }
  const order = (q: any) => {
    if (filters.sortBy === "price_desc") q = q.order("low_ask_usd", { ascending: false })
    else if (filters.sortBy === "fmv_desc") q = q.order("fmv_usd", { ascending: false, nullsFirst: false })
    else if (filters.sortBy === "discount_desc") q = q.order("discount_pct", { ascending: false, nullsFirst: false })
    else if (filters.sortBy === "discount_asc") q = q.order("discount_pct", { ascending: true, nullsFirst: false })
    else if (filters.sortBy === "recent" || filters.sortBy === "listed_desc") q = q.order("ask_confirmed_at", { ascending: false, nullsFirst: false })
    else q = q.order("low_ask_usd", { ascending: true })
    // Deterministic tiebreak on the view's unique key.
    return q.order("external_id", { ascending: true })
  }

  // ⚠ DISCOUNT SORTS FETCH THE NON-LOW WINDOW FIRST (2026-09-25). The shared
  // mapper demotes LOW-confidence rows below verified ones, but it only reorders
  // the rows it was GIVEN: ordering the whole board by discount filled the
  // 500-row window with LOW rows (312 of the top 500), so ~109 of the 293
  // non-LOW editions with a real discount could not be reached under
  // "Discount ↓". The LOW rows ride in a second window, after.
  const discountSort = filters.sortBy === "discount_desc" || filters.sortBy === "discount_asc"
  let data: any[] | null
  let error: { message: string } | null
  if (discountSort) {
    const [hi, lo] = await Promise.all([
      boundedRead(order(build().neq("confidence", "LOW")).limit(window), "api/market/panini_market_board"),
      boundedRead(order(build().eq("confidence", "LOW")).limit(window), "api/market/panini_market_board_low"),
    ])
    error = hi.error ?? lo.error ?? null
    data = error ? null : [...(hi.data ?? []), ...(lo.data ?? [])]
  } else {
    const r = await boundedRead(order(build()).limit(window), "api/market/panini_market_board")
    error = r.error
    data = r.data
  }
  if (error) {
    console.log("[/api/market] panini fetch err:", error.message)
    // null, NOT []: an empty array would read as "the Panini market is empty".
    return null
  }
  const rows = exactSetMatch(data ?? [], filters.sets, "set_name")
  return rows.map((r: any) => ({
    id: `${PANINI_COLLECTION_ID_FOR_DISPATCH}:${r.external_id}`,
    flow_id: null,
    moment_id: null,
    edition_key: r.external_id ?? null,
    player_name: r.player_name ?? null,
    team_name: null, // a nation is not a team (go-live doc gap 3)
    set_name: r.set_name ?? null,
    series_name: null,
    tier: r.tier ? String(r.tier).toUpperCase() : null,
    subedition_name: null,
    serial_number: null,
    circulation_count: r.circulation_count ?? null,
    listed_count: r.listed_count ?? null,
    ask_price: r.low_ask_usd != null ? Number(r.low_ask_usd) : null,
    fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
    adjusted_fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
    discount: r.discount_pct != null ? Number(r.discount_pct) : null,
    confidence: r.confidence ?? null,
    // LOW is Panini's MOST COMMON confidence (2,491 of 5,094 editions,
    // 2026-09-25) and its discounts read absurdly on live data — a $2 ask
    // against a $72.92 LOW FMV rendered as −97% at the top of discount sort.
    // Flagged so the shared mapper demotes it and shows "⚠ thin data", the
    // treatment ASK_ONLY already gets.
    fmv_low_confidence: String(r.confidence ?? "").toUpperCase() === "LOW",
    source: "panini",
    buy_url: r.external_id
      ? `https://nft.paniniamerica.net/marketplace-details/${encodeURIComponent(r.external_id)}.html`
      : null,
    // ⛔ NULL, not r.thumbnail_url: Panini's stored thumbnails are RELATIVE paths
    // ("pack/1038/thumbnail/…", measured 2026-09-25 on all 5,094) with no known
    // host, so the browser would request them from OUR domain — a broken image
    // on every row. No image is honest; a guessed CDN host is not.
    thumbnail_url: null,
    badge_slugs: null,
    listing_resource_id: null,
    storefront_address: null,
    is_locked: false,
    raw_data: null,
    listed_at: r.ask_confirmed_at ?? null,
    cached_at: r.ask_confirmed_at ?? null,
    collection_id: PANINI_COLLECTION_ID_FOR_DISPATCH,
  }))
}

async function fetchModernListings(
  collectionId: string,
  filters: {
    tier: string; team: string; maxPrice: number; minDiscount: number; sortBy: string; limit: number
    // Every modern arm honours these AT THE SOURCE (register #129): Pinnacle and
    // Candy in their PostgREST query, Top Shot and All Day as RPC parameters
    // (`rpcBrowseFilterArgs`). ⛔ Never by filtering an RPC's rows in memory —
    // its output is an already-truncated window, so that would turn "filter
    // ignored" into a confident "no listings in this set".
    sets: string[]; seriesList: string[]; player: string; minPrice: number
  }
): Promise<any[] | null> {
  if (collectionId === PANINI_COLLECTION_ID_FOR_DISPATCH) {
    return fetchPaniniMarketListings({
      tier: filters.tier, maxPrice: filters.maxPrice, sortBy: filters.sortBy, limit: filters.limit,
      sets: filters.sets, seriesList: filters.seriesList, player: filters.player, minPrice: filters.minPrice,
    })
  }
  if (collectionId === CANDY_COLLECTION_ID_FOR_DISPATCH) {
    return fetchCandyMarketListings({
      tier: filters.tier, maxPrice: filters.maxPrice, sortBy: filters.sortBy, limit: filters.limit,
      sets: filters.sets, seriesList: filters.seriesList, player: filters.player, minPrice: filters.minPrice,
    })
  }
  if (collectionId === PINNACLE_COLLECTION_ID_FOR_DISPATCH) {
    return fetchPinnacleModernListings(collectionId, {
      tier: filters.tier, maxPrice: filters.maxPrice, sortBy: filters.sortBy,
      sets: filters.sets, seriesList: filters.seriesList, player: filters.player, minPrice: filters.minPrice,
    })
  }
  // AllDay Market is edition-level (Trevor, 2026-07-18): one row per edition via
  // get_allday_market_editions (SQL aggregate over 80k+ active listings), NOT the
  // per-listing get_allday_market_listings feed.
  if (collectionId === ALLDAY_COLLECTION_ID_FOR_DISPATCH) {
    return fetchAllDayMarketEditions({
      tier: filters.tier, team: filters.team, maxPrice: filters.maxPrice, sortBy: filters.sortBy, limit: filters.limit,
      sets: filters.sets, seriesList: filters.seriesList, player: filters.player, minPrice: filters.minPrice,
    })
  }
  let rpcName: string | null = null
  // TS continues to use the FMV-required sniper RPC: its data source is
  // badge_editions, one row per edition (already edition-grain), which only has
  // rows with low_ask + a matching FMV snapshot, so gating on FMV drops nothing.
  if (collectionId === TS_COLLECTION_ID_FOR_DISPATCH) rpcName = "get_topshot_sniper_deals"
  if (!rpcName) return null

  // Map Market's SortKey to a value the dispatched RPC understands. The sort
  // vocabulary mirrors /api/sniper-feed: "price_asc", "price_desc",
  // "fmv_desc", "discount_desc", "listed_desc". The AllDay market RPC defaults
  // to "listed_desc"; Market's "recent" default maps onto it. price + fmv +
  // discount pass through; everything else falls back to listed_desc.
  let rpcSort: string
  if (filters.sortBy === "recent" || filters.sortBy === "listed_desc") rpcSort = "listed_desc"
  else if (filters.sortBy.startsWith("price")) rpcSort = filters.sortBy
  else if (filters.sortBy === "fmv_desc") rpcSort = "fmv_desc"
  else if (filters.sortBy === "discount_desc") rpcSort = "discount_desc"
  // #146 (1), 2026-09-26: the ascending keys have their own ORDER BY branches
  // (migration audit_20260926_market_rpcs_take_fmv_asc_and_discount_asc). They
  // used to fall to listed_desc, so the window was cut by the wrong key.
  else if (filters.sortBy === "fmv_asc") rpcSort = "fmv_asc"
  else if (filters.sortBy === "discount_asc") rpcSort = "discount_asc"
  else rpcSort = "listed_desc"

  const { data, error } = await boundedRead((supabaseAdmin as any).rpc(rpcName, {
    p_min_discount: 0, // Market should NOT pre-filter by discount; that filter is applied later in-app
    p_max_price: filters.maxPrice > 0 ? filters.maxPrice : 0,
    p_rarity: filters.tier && filters.tier !== "all" ? filters.tier : "all",
    p_team: filters.team && filters.team !== "all" ? filters.team : "all",
    p_sort_by: rpcSort,
    // Pull enough so downstream pagination has headroom. ⚠ DISCOUNT SORTS PULL
    // 1,000 (known-issues #146): the RPC ranks by RAW discount and this route
    // demotes thin / stale / ask-only FMV only AFTER the fetch, so a 500-row
    // window held 261 of the 353 HIGH/MEDIUM positive-discount editions — 92
    // real deals could not be reached under "Discount ↓" (measured 2026-09-25).
    // 1,000 (PostgREST's row cap) holds 349, for ~+35 % buffers (11.6k -> ~15k).
    p_limit: rpcSort.startsWith("discount") ? Math.max(filters.limit, 1000) : Math.max(filters.limit, 500),
    ...rpcBrowseFilterArgs(filters),
  }), `api/market/${rpcName}`)
  if (error) {
    console.log(`[/api/market] modern fetch err (${rpcName}):`, error.message)
    return []
  }

  // Reshape sniper RPC rows into the cached_listings field shape the rest of
  // the handler expects.
  return (data ?? []).map((r: any) => ({
    id: r.listing_resource_id ?? `${collectionId}:${r.moment_id ?? r.flow_id ?? Math.random()}`,
    flow_id: r.flow_id ?? null,
    moment_id: r.moment_id ?? null,
    player_name: r.player_name ?? null,
    team_name: r.team_name ?? null,
    set_name: r.set_name ?? null,
    series_name: r.series_name ?? null,
    // Strip the AllDay GQL MOMENT_TIER_ prefix so downstream TIER_CEILING
    // lookups + UI tier-filter behavior match the canonical short form
    // ("COMMON" / "RARE" / "LEGENDARY" / "ULTIMATE").
    tier: r.tier ? String(r.tier).replace("MOMENT_TIER_", "") : null,
    subedition_name: r.subedition_name ?? null,   // TS parallel printing name (Hexwave/Jukebox/…)
    serial_number: r.serial_number ?? null,
    circulation_count: r.circulation_count ?? null,
    ask_price: r.ask_price != null ? Number(r.ask_price) : null,
    fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
    adjusted_fmv: r.fmv_usd != null ? Number(r.fmv_usd) : null,
    discount: r.discount_pct != null ? Number(r.discount_pct) : null,
    confidence: r.confidence ?? null,
    source: r.source ?? null,
    buy_url: r.buy_url ?? null,
    thumbnail_url: r.thumbnail_url ?? null,
    badge_slugs: null,
    listing_resource_id: r.listing_resource_id ?? null,
    storefront_address: null,
    is_locked: false,
    raw_data: null,
    listed_at: r.listed_at ?? null,
    cached_at: r.listed_at ?? null,
    collection_id: collectionId,
  }))
}

const MARKET_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  const collectionParam = (sp.get("collectionId") || sp.get("collection_id") || "").trim()
  if (!collectionParam) {
    return NextResponse.json(
      { error: "collectionId is required" },
      { status: 400 }
    )
  }
  // A collection SLUG names the same subject as its UUID, so it resolves; any
  // other non-UUID value is a 400. It used to reach a uuid column raw:
  // `?collectionId=disney-pinnacle` → 22P02 → a 500 (production, 2026-09-26).
  const collectionId = MARKET_UUID_RE.test(collectionParam)
    ? collectionParam.toLowerCase()
    : getCollectionUuid(collectionParam)
  if (!collectionId) {
    return NextResponse.json(
      { error: "unknown collection: " + collectionParam },
      { status: 400 }
    )
  }

  // ── Filters ─────────────────────────────────────────────────────────────
  const tierRaw = sp.get("tier") || ""
  const tiers = tierRaw
    ? tierRaw.split(",").map(t => t.trim().toUpperCase()).filter(Boolean)
    : []

  const minPrice = parseFloat(sp.get("minPrice") || "")
  const maxPrice = parseFloat(sp.get("maxPrice") || "")
  const minDiscount = parseFloat(sp.get("minDiscount") || "")
  const hasMinDiscountFilter = Number.isFinite(minDiscount) && minDiscount > 0
  const maxDiscount = parseFloat(sp.get("maxDiscount") || "")
  const player = (sp.get("player") || "").trim()
  const setRaw = sp.get("set") || ""
  const sets = setRaw
    ? setRaw.split(",").map(s => s.trim()).filter(Boolean)
    : []
  const seriesRaw = sp.get("series") || ""
  const seriesList = seriesRaw
    ? seriesRaw.split(",").map(s => s.trim()).filter(Boolean)
    : []
  const teamRaw = sp.get("team") || ""
  const teams = teamRaw
    ? teamRaw.split(",").map(t => t.trim()).filter(Boolean)
    : []
  const badgeRaw = sp.get("badges") || ""
  const badges = badgeRaw
    ? badgeRaw.split(",").map(b => b.trim()).filter(Boolean)
    : []
  const hasBadges = sp.get("hasBadges") === "true" || badges.length > 0
  const specialSerials = sp.get("specialSerials") === "true"
  const parallel = (sp.get("parallel") || "").trim()

  // ── Pagination + sort ──────────────────────────────────────────────────
  const rawLimit = parseInt(sp.get("limit") || `${DEFAULT_LIMIT}`, 10)
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT))
  const rawPage = parseInt(sp.get("page") || "1", 10)
  const page = Math.max(1, Number.isFinite(rawPage) ? rawPage : 1)
  const offset = (page - 1) * limit

  // Default cheapest-first (Trevor, 2026-07-18) — Market is the browse surface;
  // the client sends an explicit sort, so this only governs direct/no-sort calls.
  const sortRaw = (sp.get("sort") || "price_asc") as SortKey
  const sort: SortKey = ALLOWED_SORTS.has(sortRaw) ? sortRaw : "price_asc"

  try {
    // P1a display guard — Top Shot only. Clamps fake discounts (ask below an
    // FMV that exceeds the edition's own 90d max sale) and flags thin-data FMV.
    const isTopShotColl = collectionId === TS_COLLECTION_ID
    const fmvGuard: FmvGuardMap = isTopShotColl
      ? await loadTopshotFmvGuard(supabaseAdmin as any)
      : new Map()

    // Modern-source dispatch (Phase 3.5). TS + AllDay come from sniper RPCs
    // that read badge_editions / cached_listings_v2 respectively. Other
    // collections fall through to the legacy cached_listings query below.
    const modernRows = await fetchModernListings(collectionId, {
      tier: tiers[0] ?? "all",
      team: teams[0] ?? "all",
      maxPrice: Number.isFinite(maxPrice) ? maxPrice : 0,
      minDiscount: Number.isFinite(minDiscount) ? minDiscount : 0,
      sortBy: sort,
      // ⚠ A Min-discount filter runs IN APP over the fetched window (the RPCs take
      // p_min_discount 0 — a serial-adjusted FMV can raise a row's discount above
      // the RPC's, so pre-filtering there would drop real matches). With Price ↑ +
      // Min 30 % the window was the 500 cheapest editions, and the page showed only
      // the 30 %-off rows among THOSE (known-issues #146 (2)). Pull the full 1,000
      // (PostgREST's cap) whenever the filter is set; the total stays a floor.
      limit: hasMinDiscountFilter ? MAX_LIMIT : limit,
      sets,
      seriesList,
      player,
      minPrice: Number.isFinite(minPrice) ? minPrice : 0,
    })
    // Fall through to the legacy cached_listings query when modern returns
    // empty. The sniper RPCs inner-join FMV, so collections with sparse FMV
    // (notably AllDay's ~341 priced rows vs ~34k v2 listings) come back 0;
    // the legacy table is stale-but-non-empty for those cases.
    if (modernRows !== null && modernRows.length === 0) {
      console.log(`[/api/market] modern returned 0 rows for ${collectionId} — falling through to cached_listings`)
    }
    // ⛔ CANDY NEVER FALLS THROUGH, and this guard is the whole reason the Candy
    // arm can exist safely. The fall-through below re-queries `cached_listings`,
    // which is a FLOW table holding ZERO Candy rows — so for Candy it cannot
    // return anything but an empty array. A failed read would therefore render
    // as "no listings", a confident, correct-looking claim about a market that
    // had 1,821 active listings the day this shipped. That is the honesty shape
    // this codebase exists to refuse, and it would be invisible: an empty market
    // and a broken market look identical on the page.
    //
    // A genuine zero short-circuits here too — not because it would be wrong to
    // fall through, but because spending a second query to reach the same empty
    // answer only widens the window in which the two can disagree.
    // Panini's listing-gated coverage rides every Panini response (overview +
    // market carry the same disclosure). A failed read drops the FIGURES; the
    // client still renders the principle.
    const isPanini = collectionId === PANINI_COLLECTION_ID_FOR_DISPATCH
    const paniniCoverage = isPanini ? await readPaniniCoverage(supabaseAdmin, "api/market/panini_coverage") : null
    const coverageField = isPanini ? { coverage: paniniCoverage?.ok ? paniniCoverage.coverage : null, coverage_failed: !paniniCoverage?.ok } : {}
    // ⛔ PANINI NEVER FALLS THROUGH either — same reason as Candy below:
    // `cached_listings` holds ZERO Panini rows, so a fall-through can only turn a
    // failed read into a confident "no listings".
    // ⛔ PINNACLE NEVER FALLS THROUGH either (2026-09-26): `cached_listings` holds
    // ZERO Pinnacle rows (measured), so a failed catalog read became "no listings".
    const isPinnacle = collectionId === PINNACLE_COLLECTION_ID_FOR_DISPATCH
    if ((collectionId === CANDY_COLLECTION_ID_FOR_DISPATCH || isPanini || isPinnacle) && (modernRows === null || modernRows.length === 0)) {
      if (modernRows === null) {
        return NextResponse.json(
          { error: "market_unavailable", retry: true, collection_id: collectionId },
          { status: 503 }
        )
      }
      // ⚠ The SAME envelope the modern branch returns. MarketClient reads
      // `pagination.total` / `.hasMore`; a flat `{total, has_more}` here would
      // leave those undefined and the page would render its loading skeleton
      // forever on a legitimately empty market.
      return NextResponse.json({
        listings: [],
        pagination: { total: 0, page, limit, hasMore: false, totalIsExact: true, matchedBeforeFilters: null },
        clamp: { applied: true, ceilings: TIER_CEILING },
        diagnostics: { rawCount: 0, postClampCount: 0, postFilterCount: 0, source: isPanini ? "panini_market_board" : isPinnacle ? "pinnacle_catalog" : "candy_market_board", windowTruncated: false },
        ...coverageField,
      }, {
        headers: { "Cache-Control": "public, s-maxage=90, stale-while-revalidate=60" },
      })
    }
    if (modernRows !== null && modernRows.length > 0) {
      // Reuse the existing edition-lookup + clamp + discount + sort + paginate
      // pipeline by stuffing modernRows into the same `data` variable the
      // downstream code consumes. The DB query is short-circuited.
      const data = modernRows
      const count = modernRows.length
      const editionLookup = await loadEditionLookup(collectionId)

      const clamped = (data ?? []).filter((r: any) => {
        const tier = typeof r.tier === "string" ? r.tier.toUpperCase() : null
        const ceiling = tier ? TIER_CEILING[tier] : null
        if (ceiling != null && Number(r.ask_price) >= ceiling) return false
        return true
      })

      const isTopShot = collectionId === TS_COLLECTION_ID

      const enriched = clamped.map((r: any) => {
        const ask = r.ask_price != null ? Number(r.ask_price) : null
        const rawFmv = r.fmv != null ? Number(r.fmv) : null
        const lookupKey = normJoinKey(r.player_name, r.set_name)
        const ed = lookupKey ? editionLookup.get(lookupKey) : null
        // Prefer the row's own edition key when the source carries one (AllDay
        // editions RPC → external_id; Pinnacle catalog → render_id); otherwise
        // derive it from the editions-table lookup (TS on-chain integer form).
        let editionKey: string | null = r.edition_key ?? null
        if (!editionKey && ed) {
          if (isTopShot && ed.set_id_onchain != null && ed.play_id_onchain != null) {
            editionKey = `${ed.set_id_onchain}:${ed.play_id_onchain}`
          } else if (!isTopShot && ed.external_id) {
            editionKey = ed.external_id
          } else if (ed.external_id && /^\d+:\d+$/.test(ed.external_id)) {
            editionKey = ed.external_id
          }
        }
        // P1a: clamp FMV to the 90d max sale when it overshoots, then compute
        // the discount off the honest figure so no fake bargain surfaces.
        const g = isTopShot
          ? guardTopshotFmv(fmvGuard, r.moment_id ?? editionKey, rawFmv)
          : { effectiveFmv: rawFmv ?? 0, lowConfidenceFmv: false }
        const fmv = rawFmv == null ? null : g.effectiveFmv
        const discount = computeDiscount(ask, fmv)
        // Edition-wide badges: prefer the row's own (AllDay editions RPC), else
        // the editions-table lookup (TS). Market never shows special-serial badges.
        const rowBadges = Array.isArray(r.badge_slugs) ? r.badge_slugs : []
        const editionBadges = ed && Array.isArray(ed.badges) ? ed.badges : []
        const badgeSlugs = rowBadges.length > 0 ? rowBadges : editionBadges
        const listedCount = r.listed_count != null ? Number(r.listed_count) : null
        const serial = r.serial_number != null ? Number(r.serial_number) : null
        const circ = r.circulation_count != null ? Number(r.circulation_count) : null
        const isSpecialSerial =
          (serial != null && serial === 1) ||
          (serial != null && circ != null && circ > 0 && serial === circ)
        return {
          id: r.id,
          flowId: r.flow_id,
          momentId: r.moment_id,
          playerName: r.player_name,
          teamName: r.team_name,
          setName: r.set_name,
          seriesName: r.series_name,
          tier: r.tier,
          // TopShot parallel/subedition printing name (Hexwave, Jukebox, …) from
          // editions.subedition_name via get_topshot_sniper_deals; null for base
          // editions and non-TS collections (no parallel concept).
          parallel: r.subedition_name ?? null,
          serialNumber: serial,
          circulationCount: circ,
          listedCount,
          askPrice: ask,
          fmv,
          discount,
          // Treat ASK_ONLY FMV as thin data: its "FMV" is derived from an ask
          // (low_ask×0.9), never from sales, so ANY discount vs it is ask-vs-ask,
          // not a real deal (a stale $700 ask → $385 FMV makes a fresh $12
          // listing render "−97%"). Flagging it flows through the same "⚠ thin
          // data" chip + discount-sort demotion the P2.5 guard already applies.
          lowConfidenceFmv: g.lowConfidenceFmv || fmvCannotAnchorDiscount(r.confidence) || r.fmv_low_confidence === true,
          confidence: r.confidence,
          source: r.source,
          buyUrl: r.buy_url,
          thumbnailUrl: r.thumbnail_url,
          badgeSlugs,
          editionKey,
          isSpecialSerial,
          listingResourceId: r.listing_resource_id,
          storefrontAddress: r.storefront_address,
          isLocked: r.is_locked,
          listedAt: r.listed_at,
          cachedAt: r.cached_at,
          collectionId: r.collection_id,
        }
      })

      const hasMinDiscount = Number.isFinite(minDiscount)
      const hasMaxDiscount = Number.isFinite(maxDiscount)
      let postFiltered = enriched
      if (hasMinDiscount || hasMaxDiscount) {
        postFiltered = postFiltered.filter(r => {
          if (r.discount == null) return false
          if (hasMinDiscount && r.discount < minDiscount) return false
          if (hasMaxDiscount && r.discount > maxDiscount) return false
          return true
        })
      }
      if (specialSerials) postFiltered = postFiltered.filter(r => r.isSpecialSerial)
      // Authoritatively order the modern feed in-memory so the shown order ALWAYS
      // matches the selected sort — the upstream sniper RPCs don't reliably honor
      // every sort value (e.g. get_topshot_sniper_deals silently ignores
      // "listed_desc" and falls back to discount), which used to make the label lie.
      // discount sort also demotes thin-data (lowConfidenceFmv) below verified rows
      // so a real 30%-off deal outranks a fake 91%-off thin common.
      const listedTs = (v: string | null | undefined) => (v ? Date.parse(v) || 0 : 0)
      switch (sort) {
        case "price_asc":
          postFiltered.sort((a, b) => (a.askPrice ?? Infinity) - (b.askPrice ?? Infinity)); break
        case "price_desc":
          postFiltered.sort((a, b) => (b.askPrice ?? -Infinity) - (a.askPrice ?? -Infinity)); break
        case "fmv_asc":
          postFiltered.sort((a, b) => (a.fmv ?? Infinity) - (b.fmv ?? Infinity)); break
        case "fmv_desc":
          postFiltered.sort((a, b) => (b.fmv ?? -Infinity) - (a.fmv ?? -Infinity)); break
        case "discount_desc":
          postFiltered.sort((a, b) => Number(!!a.lowConfidenceFmv) - Number(!!b.lowConfidenceFmv) || (b.discount ?? -Infinity) - (a.discount ?? -Infinity)); break
        case "discount_asc":
          postFiltered.sort((a, b) => Number(!!a.lowConfidenceFmv) - Number(!!b.lowConfidenceFmv) || (a.discount ?? Infinity) - (b.discount ?? Infinity)); break
        case "recent":
        default:
          postFiltered.sort((a, b) => listedTs(b.listedAt) - listedTs(a.listedAt)); break
      }

      // Unlike the legacy branch below, `count` here is just modernRows.length —
      // the sniper RPC is already called with `limit`, so this branch only ever
      // sees ONE page and can never observe rows beyond it. `total` is therefore
      // exact for what was fetched but is a floor whenever the RPC returned a
      // full page (there may be more upstream). Flagged rather than implied.
      const total = postFiltered.length
      const paged = postFiltered.slice(offset, offset + limit)
      const hasMore = offset + limit < total
      const modernPageFull = (data?.length ?? 0) >= limit

      return NextResponse.json({
        listings: paged,
        pagination: {
          total,
          page,
          limit,
          hasMore,
          totalIsExact: !modernPageFull,
          matchedBeforeFilters: null,
        },
        clamp: { applied: true, ceilings: TIER_CEILING },
        diagnostics: { rawCount: count, postClampCount: clamped.length, postFilterCount: total, source: "modern", windowTruncated: modernPageFull },
        ...coverageField,
      }, {
        headers: { "Cache-Control": "public, s-maxage=90, stale-while-revalidate=60" },
      })
    }

    // Primary query — pull up to MAX_LIMIT rows for this collection with
    // filters applied. We then compute discount in app code, apply the
    // discount filter + discount sort, and slice for pagination.
    let q = supabaseAdmin
      .from("cached_listings")
      .select("*", { count: "exact" })
      .eq("collection_id", collectionId)
      .not("ask_price", "is", null)
      .lte("ask_price", ABSOLUTE_CEILING)

    if (tiers.length > 0) q = q.in("tier", tiers)
    if (Number.isFinite(minPrice) && minPrice > 0) q = q.gte("ask_price", minPrice)
    if (Number.isFinite(maxPrice) && maxPrice > 0) q = q.lte("ask_price", maxPrice)
    if (player) q = q.ilike("player_name", `%${player}%`)
    if (sets.length > 0) q = q.in("set_name", sets)
    if (seriesList.length > 0) q = q.in("series_name", seriesList)
    if (teams.length > 0) q = q.in("team_name", teams)
    if (hasBadges) q = q.not("badge_slugs", "is", null)
    if (badges.length > 0) q = q.overlaps("badge_slugs", badges)
    if (parallel) q = q.ilike("raw_data->>parallel", `%${parallel}%`)

    // DB-level sort only for columns PostgREST can order on directly.
    // Discount sort happens in memory after discount + clamp filter.
    const nullsLast = { nullsFirst: false } as const
    switch (sort) {
      case "price_asc":  q = q.order("ask_price", { ascending: true,  ...nullsLast }); break
      case "price_desc": q = q.order("ask_price", { ascending: false, ...nullsLast }); break
      case "fmv_asc":    q = q.order("fmv",       { ascending: true,  ...nullsLast }); break
      case "fmv_desc":   q = q.order("fmv",       { ascending: false, ...nullsLast }); break
      case "discount_asc":
      case "discount_desc":
      case "recent":
      default:
        q = q.order("listed_at", { ascending: false, ...nullsLast }); break
    }

    // Fetch a larger window when discount sort is active so in-memory sort
    // gives a stable ordering across pagination.
    // A Min-discount filter also pulls the full window: it runs in app, after the fetch (#146 (2)).
    const fetchLimit = sort.startsWith("discount") || hasMinDiscountFilter ? MAX_LIMIT : Math.min(MAX_LIMIT, offset + limit + 100)
    q = q.range(0, fetchLimit - 1)

    // Run editions lookup in parallel with the main query.
    // ⚠ BOUNDED (2026-09-13). The modern path above is bounded at 8 s and,
    // when it times out, falls through HERE — where this read ran with no
    // bound and the lambda was killed at its 30 s wall: measured on the
    // 2026-09-13 production deploy, `get_topshot_sniper_deals` "read exceeded
    // 8000ms" → "falling through to cached_listings" → "Task timed out after
    // 30 seconds", a 504 in place of the honest 503 three lines below (12 of
    // 587 /api/market responses in 24 h were 504s). A read that is merely slow
    // errors nowhere on its own; this makes it reach the branch that exists.
    const [{ data, error, count }, editionLookup] = await Promise.all([
      boundedRead(q, "api/market/cached_listings"),
      loadEditionLookup(collectionId),
    ])

    if (error) {
      console.log("[/api/market] query error:", error.message)
      return apiErrorResponse(error, "api/market")
    }

    // ── Tier-based outlier clamp + edition enrichment + discount ─────────
    const clamped = (data ?? []).filter((r: any) => {
      const tier = typeof r.tier === "string" ? r.tier.toUpperCase() : null
      const ceiling = tier ? TIER_CEILING[tier] : null
      if (ceiling != null && Number(r.ask_price) >= ceiling) return false
      return true
    })

    const isTopShot = collectionId === TS_COLLECTION_ID

    const enriched = clamped.map((r: any) => {
      const ask = r.ask_price != null ? Number(r.ask_price) : null
      const rawFmv = r.fmv != null ? Number(r.fmv) : null
      const lookupKey = normJoinKey(r.player_name, r.set_name)
      const ed = lookupKey ? editionLookup.get(lookupKey) : null
      // editionKey: TS uses on-chain integers (matches wmc); others use the
      // editions.external_id slug (also matches wmc for those collections).
      let editionKey: string | null = null
      if (ed) {
        if (isTopShot && ed.set_id_onchain != null && ed.play_id_onchain != null) {
          editionKey = `${ed.set_id_onchain}:${ed.play_id_onchain}`
        } else if (!isTopShot && ed.external_id) {
          editionKey = ed.external_id
        } else if (ed.external_id && /^\d+:\d+$/.test(ed.external_id)) {
          editionKey = ed.external_id
        }
      }
      // P1a: clamp FMV to the 90d max sale when it overshoots (see modern path).
      const g = isTopShot
        ? guardTopshotFmv(fmvGuard, r.moment_id ?? editionKey, rawFmv)
        : { effectiveFmv: rawFmv ?? 0, lowConfidenceFmv: false }
      const fmv = rawFmv == null ? null : g.effectiveFmv
      const discount = computeDiscount(ask, fmv)
      // Fall back to editions.badges if cached_listings.badge_slugs is empty.
      const cachedBadges = Array.isArray(r.badge_slugs) ? r.badge_slugs : []
      const editionBadges = ed && Array.isArray(ed.badges) ? ed.badges : []
      const badgeSlugs = cachedBadges.length > 0 ? cachedBadges : editionBadges
      const serial = r.serial_number != null ? Number(r.serial_number) : null
      const circ = r.circulation_count != null ? Number(r.circulation_count) : null
      const isSpecialSerial =
        (serial != null && serial === 1) ||
        (serial != null && circ != null && circ > 0 && serial === circ)
      return {
        id: r.id,
        flowId: r.flow_id,
        momentId: r.moment_id,
        playerName: r.player_name,
        teamName: r.team_name,
        setName: r.set_name,
        seriesName: r.series_name,
        tier: r.tier,
        parallel: r.subedition_name ?? null,
        serialNumber: serial,
        circulationCount: circ,
        listedCount: null,
        askPrice: ask,
        fmv,
        discount,
        // ASK_ONLY FMV is ask-derived (no sales anchor) → thin data; see the
        // modern-path note above. Suppresses fake ask-vs-ask discounts.
        lowConfidenceFmv: g.lowConfidenceFmv || fmvCannotAnchorDiscount(r.confidence),
        confidence: r.confidence,
        source: r.source,
        buyUrl: r.buy_url,
        thumbnailUrl: r.thumbnail_url,
        badgeSlugs,
        editionKey,
        isSpecialSerial,
        listingResourceId: r.listing_resource_id,
        storefrontAddress: r.storefront_address,
        isLocked: r.is_locked,
        listedAt: r.listed_at,
        cachedAt: r.cached_at,
        collectionId: r.collection_id,
      }
    })

    // Market is edition-level (Trevor, 2026-07-18): collapse the per-listing
    // cached_listings rows (Golazos / UFC) into one row per edition before
    // filtering/sorting/paginating. TS/AllDay/Pinnacle aggregate at their source.
    // Discount filter happens after computation.
    const hasMinDiscount = Number.isFinite(minDiscount)
    const hasMaxDiscount = Number.isFinite(maxDiscount)
    let postFiltered = collapseToEditions(enriched)
    if (hasMinDiscount || hasMaxDiscount) {
      postFiltered = postFiltered.filter(r => {
        if (r.discount == null) return false
        if (hasMinDiscount && r.discount < minDiscount) return false
        if (hasMaxDiscount && r.discount > maxDiscount) return false
        return true
      })
    }

    // Special-serials filter (server-side because the hint columns are
    // already on the row). Defined as serial == 1 OR serial == circulation_count.
    // Runs AFTER collapseToEditions, so it reads the representative (floor-ask)
    // listing's flag that the collapse now carries through — see the note there.
    if (specialSerials) {
      postFiltered = postFiltered.filter(r => r.isSpecialSerial)
    }

    // Apply discount sort in memory. P2.5 — demote thin-data (lowConfidenceFmv)
    // listings below verified ones so fake thin-FMV discounts don't lead.
    if (sort === "discount_desc") {
      postFiltered.sort((a, b) =>
        Number(!!a.lowConfidenceFmv) - Number(!!b.lowConfidenceFmv) || (b.discount ?? -Infinity) - (a.discount ?? -Infinity))
    } else if (sort === "discount_asc") {
      postFiltered.sort((a, b) =>
        Number(!!a.lowConfidenceFmv) - Number(!!b.lowConfidenceFmv) || (a.discount ?? Infinity) - (b.discount ?? Infinity))
    }

    // ── Honest total (fixed 2026-08-01) ────────────────────────────────────
    // This route asks PostgREST for { count: "exact" } — the true number of
    // rows matching the DB-level filters, uncapped — and then threw it away,
    // reporting `postFiltered.length` as `total`. That is NOT a total:
    //   * the fetch window is bounded by `fetchLimit`, which for every
    //     non-discount sort is only `offset + limit + 100`, so `total` was
    //     effectively the WINDOW SIZE, and
    //   * for discount sorts it is capped at MAX_LIMIT (1000).
    // Once a collection had more matching rows than the window, `total` and
    // `hasMore` under-reported and the UI stopped paginating early.
    //
    // `count` alone is not the answer either: the clamp + discount + special-
    // serial filters run in app code, so they can drop rows `count` still
    // includes. So resolve the three cases explicitly and SAY which one it is
    // rather than emitting a silently-capped number:
    //   1. the window held every matching row  -> post-filter count is exact
    //   2. window truncated, but nothing was dropped in app -> count is exact
    //   3. window truncated AND rows were dropped in app -> report a FLOOR
    const fetchedCount = data?.length ?? 0
    const dbMatched = typeof count === "number" ? count : null
    const windowHeldEverything = dbMatched !== null && dbMatched <= fetchedCount
    const droppedInApp = fetchedCount - postFiltered.length

    let total: number
    let totalIsExact: boolean
    if (windowHeldEverything) {
      total = postFiltered.length
      totalIsExact = true
    } else if (dbMatched !== null && droppedInApp === 0) {
      total = dbMatched
      totalIsExact = true
    } else {
      total = postFiltered.length
      totalIsExact = false
    }

    const paged = postFiltered.slice(offset, offset + limit)
    const hasMore = offset + limit < total

    return NextResponse.json({
      listings: paged,
      pagination: {
        total,
        page,
        limit,
        hasMore,
        // false => `total` is a LOWER BOUND: the result set was truncated by the
        // fetch window AND in-app filters removed rows, so an exact count is not
        // knowable without fetching the whole collection. Consumers should render
        // it as "N+" rather than "N".
        totalIsExact,
        // Exact count of rows matching the DB-level filters, before the in-app
        // clamp / discount / special-serial filters. null if PostgREST omitted it.
        matchedBeforeFilters: dbMatched,
      },
      clamp: {
        applied: true,
        ceilings: TIER_CEILING,
      },
      // Diagnostic: count before clamp vs after, so the Market page can
      // show a muted "N listings filtered as outliers" line when relevant.
      diagnostics: {
        rawCount: count ?? (data?.length ?? 0),
        postClampCount: clamped.length,
        postFilterCount: postFiltered.length,
        fetchedCount,
        fetchLimit,
        windowTruncated: !windowHeldEverything,
      },
    }, {
      headers: {
        // Listing cache refreshes every few minutes — 90s CDN cache with
        // 60s SWR keeps page loads snappy without serving badly stale data.
        "Cache-Control": "public, s-maxage=90, stale-while-revalidate=60",
      },
    })
  } catch (err) {
    console.log("[/api/market] error:", err instanceof Error ? err.message : String(err))
    return apiErrorResponse(err, "market", "The market board isn't available right now.")
  }
}
