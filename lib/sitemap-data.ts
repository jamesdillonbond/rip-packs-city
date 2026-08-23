// lib/sitemap-data.ts
//
// Enumerates every ANON-INDEXABLE URL on the site for search-engine crawlers.
// The sitemap must list only routes a logged-out Googlebot can actually fetch
// (HTTP 200) — anything that 302→/login wastes crawl budget and lands in GSC's
// "Page with redirect" coverage bucket. The public surface is defined by
// proxy.ts `isPublicPath`; this file mirrors it. (Pruned 2026-05-31.)
//
// Covers:
//   • root + static legal/marketing pages (about, privacy, terms)
//   • /nba/fast-break (public optimizer) + /insights/* (public wedge surfaces)
//   • /{collection}/overview + the anon-public in-app FEATURE TABS.
//     ⚠ CORRECTED 2026-08-20 — this block used to read "overview is the ONLY
//     anon-public per-collection page … the in-app feature tabs are auth-gated,
//     so they are NOT listed." That was true when written (2026-05-31) and
//     STOPPED being true on 2026-07-17, when proxy.ts un-gated the read-only
//     feature tabs for anonymous visitors (GET/HEAD, the 5 published slugs).
//     For a month those tabs were anon-200, robots-allowed, self-canonical and
//     carrying bespoke per-tab SEO copy — every signal saying "index me" — while
//     the one file whose job is to tell Googlebot they exist asserted they were
//     gated. Measured 2026-08-20: 28 such URLs.
//     The set is DERIVED, never listed: each collection's own `pages` array
//     intersected with lib/seo `PUBLIC_TAB_PAGES`. Tabs with no PAGE_META entry
//     (pack-sniper / challenges / hot-floors) are excluded because they
//     canonicalise to the collection root rather than to themselves.
//     ⚠ The /analytics/** SECTION (a different surface from the per-collection
//     /{collection}/analytics TAB) really is auth-gated and stays unlisted.
//     __tests__/sitemap-urls-are-anon-public.test.ts cross-checks every emitted
//     URL against proxy.ts `isPublicPath` in BOTH directions, so the claim in
//     this comment can no longer drift back into unverified prose.
//   • per-edition pages — every editions row in a published collection (~23.5K)
//   • per-set / per-player / per-team pages — distinct slugs derived from
//     those edition rows
//   • per-series pages — one per collection_series.display_label (~28)
//   • per-pack pages — every pack_distributions row (~5.2K)
//   • /moment/<id> — top-N cross-collection canonical detail pages
//   • /profile/<username> — public profile cards (robots allows; /profile/edit
//     is gated and never listed)
//
// Edition collections are filtered by collection_id directly (not via a
// PostgREST embedded join on collections.slug, which returned 0 rows at
// generation time). collection_series carries NO timestamp column, so its
// entries use `now` for lastModified.
//
// SPLIT (2026-07-11): served as 5 segment children via generateSitemaps()
// (/sitemap/0.xml … /sitemap/4.xml) behind a hand-rolled sitemap INDEX at
// /sitemap.xml (app/sitemap.xml/route.ts) so the GSC-registered URL keeps
// working. Segments: 0 static+insights+overviews+series+profiles,
// 1 Top Shot editions, 2 AllDay/Golazos/UFC editions,
// 3 set/player/team entities + top moments, 4 packs + Pinnacle pins.
// Each child stays far below Google's 50K-URL / 50MB caps.
// Served by app/sitemap/[id]/route.ts (children) + app/sitemap.xml/route.ts
// (index) — Next's metadata sitemap convention claims /sitemap.xml even with
// generateSitemaps (build error: 'Conflicting route and metadata'), so the
// whole surface is hand-rolled route handlers.

import type { MetadataRoute } from 'next'
import { createClient } from '@supabase/supabase-js'
import { publishedCollections } from '@/lib/collections'
import { getCollectionByDbSlug, getCollectionByUuid } from '@/lib/collection-slug'
import { slugifyName } from '@/lib/entity-labels'
import { isExhibitionTeamSlug } from '@/lib/team-denylist'
import { CANDY_MLB_PUBLIC, PANINI_PUBLIC } from '@/lib/launch-flags'
import { PUBLIC_TAB_PAGES } from '@/lib/seo'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.rippackscity.com'

/**
 * The hand-authored, non-database-derived pages of segment 0.
 *
 * ⚠ EXPORTED SO A TEST CAN READ IT, and that is the whole point. These are the
 * URLs this repo TELLS GOOGLE TO CRAWL, which is a stronger claim than "proxy.ts
 * does not redirect it" — `isPublicPath` returns true for `/admin/**` too, where
 * the page enforces its own bearer auth and an anonymous visitor sees nothing.
 * Sitemap membership is therefore the repo's own assertion that a path renders
 * real content to an anonymous crawler, which makes it the right population for
 * `__tests__/e2e-smoke-covers-sitemap-static-pages.test.ts` to demand the
 * rendered-DOM monitor covers. Restating these paths in the test would rebuild
 * the curated list the monitor already drifted on once.
 */
export const STATIC_SITEMAP_PAGES: ReadonlyArray<{
  path: string
  changeFrequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  priority: number
}> = [
  { path: '/',                                 changeFrequency: 'daily',   priority: 1.0 },
  { path: '/about',                            changeFrequency: 'monthly', priority: 0.5 },
  { path: '/privacy',                          changeFrequency: 'yearly',  priority: 0.3 },
  { path: '/terms',                            changeFrequency: 'yearly',  priority: 0.3 },
  { path: '/legal/fmv-methodology',            changeFrequency: 'monthly', priority: 0.4 },
  { path: '/blog',                             changeFrequency: 'weekly',  priority: 0.5 },
  { path: '/blog/permanent-moments-ipfs',      changeFrequency: 'monthly', priority: 0.5 },
  { path: '/blog/pinnacle-star-wars-day-2026', changeFrequency: 'monthly', priority: 0.5 },
  // Both added 2026-08-01. /pricing is public (proxy.ts:173), indexable and
  // footer-linked, but had never been enumerated here. /nba/fast-break is public
  // (proxy.ts:352) and the header comment at the top of this file has claimed it
  // was covered since the file was written — it never was. Both are genuine
  // anon-200s, so neither burns crawl budget.
  { path: '/pricing',                          changeFrequency: 'monthly', priority: 0.6 },
  { path: '/nba/fast-break',                   changeFrequency: 'daily',   priority: 0.7 },
]



async function getPublicProfiles(): Promise<Array<{ username: string; updated_at: string | null }>> {
  // profile_bio.username is the public handle for /profile/[username]. We
  // pull the rows where that's been set so each public profile gets a
  // sitemap entry. Service-role client to bypass RLS — the username column
  // is intentionally public-readable but service role keeps this fast.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  // ⚠ A MISSING KEY IS NOT AN EMPTY CATALOGUE — see fetchAllByCollection.
  if (!url || !key) throw new SitemapReadIncomplete('public profiles: supabase env missing, so nothing could be read')
  try {
    const sb: any = createClient(url, key)
    // PostgREST caps reads at 1,000 and silently CLAMPS a bare .limit(5000) to
    // 1,000 with no error — so once public profiles pass 1,000 (self-serve signup
    // opened 2026-07-20) the sitemap would quietly drop every profile beyond the
    // first 1,000. Page in 1,000-row windows with a stable order, exactly like
    // fetchAllByCollection below (profile_bio has no collection_id to reuse it).
    const PAGE = 1000
    const out: Array<{ username: string; updated_at: string | null }> = []
    for (let from = 0; from < 50000; from += PAGE) {
      const { data, error } = await sb
        .from('profile_bio')
        .select('username, updated_at')
        .not('username', 'is', null)
        .order('username', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) {
        // R47: partial-under-200. `username` is already the order key and is
        // UNIQUE (it is the public handle), so this loop needs no tiebreaker —
        // only the honest error.
        throw new SitemapReadIncomplete(
          'profile_bio page ' + from + ' failed, so the set is partial: ' + error.message,
        )
      }
      const rows = data ?? []
      out.push(...rows)
      if (rows.length < PAGE) return out as Array<{ username: string; updated_at: string | null }>
    }
    throw new SitemapReadIncomplete('profile_bio filled every page up to 50000, so there are probably more')
  } catch (err) {
    if (err instanceof SitemapReadIncomplete) throw err
    throw new SitemapReadIncomplete(
      'profile_bio query threw: ' + (err instanceof Error ? err.message : String(err)),
    )
  }
}

// Collection UUIDs that have rows in the `editions` table. We filter by
// collection_id directly (the canonical FK) rather than via a PostgREST
// embedded join on `collections.slug` — the embed returned 0 rows at sitemap
// generation time even though the data + FK exist. Pinnacle data lives in
// `pinnacle_editions` (different schema) so it's excluded from edition
// enumeration; its entity pages are still reachable via in-app navigation.
const EDITION_COLLECTION_IDS = [
  '95f28a17-224a-4025-96ad-adf8a4c63bfd', // nba_top_shot
  'dee28451-5d62-409e-a1ad-a83f763ac070', // nfl_all_day
  '06248cc4-b85f-47cd-af67-1855d14acd75', // laliga_golazos
  '9b4824a8-736d-4a96-b450-8dcc0c46b023', // ufc_strike
]

// Pack distributions exist for the edition collections plus Disney Pinnacle.
// (Pinnacle currently has 0 pack_distributions rows but is included so new
// Pinnacle drops are picked up automatically.)
const PACK_COLLECTION_IDS = [
  ...EDITION_COLLECTION_IDS,
  '7dd9dd11-e8b6-45c4-ac99-71331f959714', // disney_pinnacle
]

/**
 * Thrown when a sitemap read could not be COMPLETED. Never swallow it into an
 * empty or partial list — see the header on `fetchAllByCollection`.
 */
export class SitemapReadIncomplete extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SitemapReadIncomplete'
  }
}

/**
 * Reject a tiebreaker that cannot break ties.
 *
 * ⚠ CHECKED BY VALUE, BECAUSE THE VALUE ONLY EXISTS AT RUNTIME. The static ban
 * in __tests__/paginated-range-requires-order-ratchet.test.ts can see that a
 * SECOND `.order()` is present but not what was passed to it — mutation proved
 * the gap: swapping `getEditionRows`'s `'id'` back to `'updated_at'` left that
 * ban green while restoring R47 in full. A shape check and a value check are
 * different guards.
 *
 * ⚠ It caught a live one on the day it was written: `getPackRows` passed
 * `'dist_id'` as BOTH keys, which reads as a tiebreaker and provides nothing.
 */
export function assertUsableTiebreak(table: string, orderColumn: string, tiebreakColumn: string): void {
  if (tiebreakColumn === orderColumn) {
    throw new Error(
      `fetchAllByCollection(${table}): tiebreakColumn must differ from orderColumn (both '${orderColumn}') — a column cannot break its own ties`,
    )
  }
  if (/(_at|_time|timestamp)$/i.test(tiebreakColumn)) {
    throw new Error(
      `fetchAllByCollection(${table}): tiebreakColumn '${tiebreakColumn}' is timestamp-shaped and cannot be unique — pass a unique key`,
    )
  }
}

// PostgREST enforces a hard db-max-rows cap (1000 on this project), so a single
// .limit(50000) silently returns only the first 1000 rows. Page through with
// .range() in 1000-row windows until a short page signals the end.
//
// ── R47 / known-issues #28, fixed 2026-08-23. TWO defects, and the first hid
//    the second. ────────────────────────────────────────────────────────────
//
// 1. THIS LOOP USED TO `break` ON ERROR AND RETURN WHAT IT HAD. Measured from a
//    production runtime log: `editions page 24000 error: canceling statement due
//    to statement timeout`, served under a **200**. A sitemap is a claim about
//    which URLs EXIST — a partial one under a 200 tells Google the missing
//    3,000-odd pages are gone. **No caller could tell a truncated list from a
//    complete one**, because the only difference was a log line.
//    ⚠ There is no copy to grep for this defect class: the tell is the
//    CONTROL-FLOW KEYWORD. It now THROWS, and the route serves 503 so a crawler
//    retries and keeps the sitemap it already has.
//
// 2. STABLE ORDERING IS NOT ENOUGH — THE KEY MUST BE UNIQUE. `.range()` paging
//    over a non-unique ORDER BY is free to return rows in a different order per
//    page, so rows repeat and rows vanish. ⚠ **The duplicates and omissions
//    CANCEL**, so every count-based check passes and only a DISTINCT count sees
//    it. `editions.updated_at` was the order key: re-measured 2026-08-23 over
//    the four published collections, **8,927 distinct values across 27,121 rows
//    — 68.4% of rows sit in a tied group, and the LARGEST TIE GROUP IS 1,084,
//    which is bigger than the 1,000-row page.** A tie group wider than a page is
//    the case where loss is not merely possible but forced.
//    Hence the required `tiebreakColumn`, which must be UNIQUE.
//
// 3. `maxRows` was a third silent truncation: the loop simply ended. It now
//    throws too, because "we stopped counting" is not "that is all of them".
async function fetchAllByCollection(
  sb: any,
  table: string,
  select: string,
  collectionIds: string[],
  orderColumn: string,
  orderAsc: boolean,
  // ⚠ MUST BE UNIQUE over the selected set, or defect 2 above is unfixed. Verified
  // live 2026-08-23: editions.id (uuid PK); pack_distributions.dist_id
  // (5,514/5,514 distinct). Do not pass a timestamp here.
  tiebreakColumn: string,
  maxRows = 60000,
): Promise<any[]> {
  // ⚠ CHECKED HERE BECAUSE THE VALUE ONLY EXISTS HERE. The static guard
  // (__tests__/paginated-range-requires-order-ratchet.test.ts) can see that a
  // SECOND `.order()` is present but not what the caller passed to it — mutation
  // proved that: swapping this call's `'id'` back to `'updated_at'` left the
  // static ban green while restoring the whole defect. A shape check and a value
  // check are different guards, and this one is two lines.
  assertUsableTiebreak(table, orderColumn, tiebreakColumn)
  const PAGE = 1000
  const out: any[] = []
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .in('collection_id', collectionIds)
      .order(orderColumn, { ascending: orderAsc, nullsFirst: false })
      .order(tiebreakColumn, { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) {
      throw new SitemapReadIncomplete(
        `${table} page ${from} failed, so the set is partial: ${error.message}`,
      )
    }
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
  throw new SitemapReadIncomplete(
    `${table} filled every page up to maxRows=${maxRows}, so there are probably more rows we never read`,
  )
}

interface EditionRow {
  id: string
  external_id: string | null
  collection_db_slug: string
  player_name: string | null
  set_name: string | null
  team_name: string | null
  last_updated_at: string | null
}

async function getEditionRows(collectionIds: string[] = EDITION_COLLECTION_IDS): Promise<EditionRow[]> {
  // One sitemap entry per edition in a published collection (~23.5K rows
  // today). Service-role client bypasses RLS; paginated via fetchAllByCollection
  // to clear the 1000-row PostgREST cap. We also derive distinct
  // set/player/team slugs from these rows for the entity sitemap entries.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  // ⚠ A MISSING KEY IS NOT AN EMPTY CATALOGUE. `return []` here published a
  // sitemap asserting the site has no editions, out of a configuration problem.
  if (!url || !key) throw new SitemapReadIncomplete('editions: supabase env missing, so nothing could be read')
  try {
    const sb: any = createClient(url, key)
    // Source the lastModified hint from `updated_at` (100% populated, kept
    // current on every row touch) rather than `editions.last_updated_at`, which
    // is an orphaned one-time backfill: only 147/24,779 rows carry a value (all
    // stamped 2026-05-06) and nothing has written it since, so reading it made
    // ~99.4% of edition URLs fall back to `now()` — a useless (always-fresh)
    // lastModified signal. Ordering by `updated_at` (non-null) also makes the
    // paginated fetch stable (null ordering is not).
    const data = await fetchAllByCollection(
      sb,
      'editions',
      'id, external_id, updated_at, player_name, set_name, team_name, collection_id',
      collectionIds,
      'updated_at',
      false,
      // ⚠ `updated_at` is 68.4% ties with a largest group of 1,084 — WIDER than
      // the 1,000-row page. The uuid PK is what makes the paging deterministic.
      'id',
    )
    return ((data ?? []) as Array<{
      id: string
      external_id: string | null
      updated_at: string | null
      player_name: string | null
      set_name: string | null
      team_name: string | null
      collection_id: string | null
    }>).map((r) => ({
      id: r.id,
      external_id: r.external_id,
      collection_db_slug: getCollectionByUuid(r.collection_id ?? '')?.dbSlug ?? '',
      player_name: r.player_name,
      set_name: r.set_name,
      team_name: r.team_name,
      last_updated_at: r.updated_at,
    }))
  } catch (err) {
    // ⚠ RETHROWN, NOT SWALLOWED (R47). `return []` here defeated the throw one
    // level down: the loop stopped lying and this caught the truth and published
    // the same empty list. Every failure to read is now the route's decision.
    if (err instanceof SitemapReadIncomplete) throw err
    throw new SitemapReadIncomplete(
      'editions query threw: ' + (err instanceof Error ? err.message : String(err)),
    )
  }
}

interface SeriesRow {
  collection_db_slug: string
  display_label: string
  last_updated_at: string | null
}

async function getCollectionSeries(): Promise<SeriesRow[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  // ⚠ A MISSING KEY IS NOT AN EMPTY CATALOGUE — see fetchAllByCollection.
  if (!url || !key) throw new SitemapReadIncomplete('collection series: supabase env missing, so nothing could be read')
  try {
    const sb: any = createClient(url, key)
    // collection_series carries no timestamp column — select only what exists
    // and let lastModified fall back to `now` downstream.
    const { data, error } = await sb
      .from('collection_series')
      .select('display_label, collection_id')
      .in('collection_id', EDITION_COLLECTION_IDS)
      .limit(2000)
    if (error) {
      // R47: a failed read is not "this site has no series".
      throw new SitemapReadIncomplete('collection_series read failed: ' + error.message)
    }
    return ((data ?? []) as Array<{
      display_label: string | null
      collection_id: string | null
    }>)
      .filter((r) => typeof r.display_label === 'string' && r.display_label.length > 0)
      .map((r) => ({
        collection_db_slug: getCollectionByUuid(r.collection_id ?? '')?.dbSlug ?? '',
        display_label: r.display_label as string,
        last_updated_at: null,
      }))
  } catch (err) {
    if (err instanceof SitemapReadIncomplete) throw err
    throw new SitemapReadIncomplete(
      'collection_series query threw: ' + (err instanceof Error ? err.message : String(err)),
    )
  }
}

interface PackRow {
  dist_id: string
  collection_id: string
  updated_at: string | null
}

async function getPackRows(): Promise<PackRow[]> {
  // One sitemap entry per pack distribution → /<collection>/pack/dist/<distId>.
  // Filtered by collection_id (the canonical FK) over the published
  // collections. ~5.2K rows today (AllDay + Top Shot + Golazos).
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  // ⚠ A MISSING KEY IS NOT AN EMPTY CATALOGUE. `return []` here published a
  // sitemap asserting the site has no pack distributions, out of a configuration problem.
  if (!url || !key) throw new SitemapReadIncomplete('pack distributions: supabase env missing, so nothing could be read')
  try {
    const sb: any = createClient(url, key)
    const data = await fetchAllByCollection(
      sb,
      'pack_distributions',
      'dist_id, collection_id, updated_at',
      PACK_COLLECTION_IDS,
      'dist_id',
      true,
      // ⚠ `dist_id` is already unique here (5,514/5,514 distinct, verified
      // 2026-08-23), so this tiebreaker is a no-op — but it must still be a
      // DIFFERENT column: the helper rejects `tiebreakColumn === orderColumn`,
      // and it caught this line when it was first written as `'dist_id'`. A
      // column cannot break its own ties, so passing the same one reads as a
      // tiebreaker while providing nothing.
      'id',
    )
    return ((data ?? []) as Array<{
      dist_id: string | null
      collection_id: string | null
      updated_at: string | null
    }>)
      .filter((r) => typeof r.dist_id === 'string' && r.dist_id.length > 0 && !!r.collection_id)
      .map((r) => ({
        dist_id: r.dist_id as string,
        collection_id: r.collection_id as string,
        updated_at: r.updated_at,
      }))
  } catch (err) {
    // ⚠ RETHROWN, NOT SWALLOWED (R47). `return []` here defeated the throw one
    // level down: the loop stopped lying and this caught the truth and published
    // the same empty list. Every failure to read is now the route's decision.
    if (err instanceof SitemapReadIncomplete) throw err
    throw new SitemapReadIncomplete(
      'pack_distributions query threw: ' + (err instanceof Error ? err.message : String(err)),
    )
  }
}

interface PinnacleRenderRow {
  render_id: string
  updated_at: string | null
}

async function getPinnacleRenderRows(): Promise<PinnacleRenderRow[]> {
  // One sitemap entry per Pinnacle render → /pinnacle/moment/<render_id> (the
  // render-keyed per-pin page, Wave 1b). pinnacle_catalog has no collection_id
  // (it's all Pinnacle), so page it directly rather than via fetchAllByCollection.
  // Limited to catalogued pins (character_name present) — ~2,079 rows.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  // ⚠ A MISSING KEY IS NOT AN EMPTY CATALOGUE. `return []` here published a
  // sitemap asserting the site has no pinnacle renders, out of a configuration problem.
  if (!url || !key) throw new SitemapReadIncomplete('pinnacle renders: supabase env missing, so nothing could be read')
  try {
    const sb: any = createClient(url, key)
    const PAGE = 1000
    const out: PinnacleRenderRow[] = []
    for (let from = 0; from < 10000; from += PAGE) {
      const { data, error } = await sb
        .from('pinnacle_catalog')
        .select('render_id, updated_at')
        .not('render_id', 'is', null)
        .not('character_name', 'is', null)
        .order('render_id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) {
        // Same defect as fetchAllByCollection's, in the one loop that does not
        // use it (pinnacle_catalog has no collection_id to filter on).
        throw new SitemapReadIncomplete(
          'pinnacle_catalog page ' + from + ' failed, so the set is partial: ' + error.message,
        )
      }
      const rows = (data ?? []) as PinnacleRenderRow[]
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
    throw new SitemapReadIncomplete('pinnacle_catalog filled every page up to 10000, so there are probably more')
  } catch (err) {
    // ⚠ RETHROWN, NOT SWALLOWED (R47). `return []` here defeated the throw one
    // level down: the loop stopped lying and this caught the truth and published
    // the same empty list. Every failure to read is now the route's decision.
    if (err instanceof SitemapReadIncomplete) throw err
    throw new SitemapReadIncomplete(
      'pinnacle_catalog query threw: ' + (err instanceof Error ? err.message : String(err)),
    )
  }
}

const TS_ID = '95f28a17-224a-4025-96ad-adf8a4c63bfd'

// Inert UUID-keyed Top Shot fossil filter (see segment notes below): canonical
// TS editions are int-pair keyed (`setID:playID`, no hyphen); hyphenated
// external_ids are dedup-merge leftovers with NULL on-chain ids that Google
// flags "Duplicate, chose different canonical". TS-scoped ONLY — UFC canonical
// ids are uuid-like (hyphenated) and must not be dropped.
function dropTsFossils(rows: EditionRow[]): EditionRow[] {
  return rows.filter(
    (e) => !(e.collection_db_slug === 'nba_top_shot' && (e.external_id ?? '').includes('-')),
  )
}

function buildEditionPages(editions: EditionRow[], now: Date): MetadataRoute.Sitemap {
  return editions
    .filter((e) => !!e.external_id)
    .map((e) => {
      const coll = getCollectionByDbSlug(e.collection_db_slug)
      if (!coll) return null
      return {
        url: `${BASE_URL}/${coll.urlSlug}/edition/${encodeURIComponent(e.external_id as string)}`,
        lastModified: e.last_updated_at ? new Date(e.last_updated_at) : now,
        changeFrequency: 'daily' as const,
        priority: 0.6,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
}

export const SITEMAP_SEGMENT_IDS = [0, 1, 2, 3, 4]

export async function buildSitemapSegment(id: number): Promise<MetadataRoute.Sitemap> {
  const now = new Date()

  // ── Segment 1: Top Shot edition pages ─────────────────────────────────────
  if (id === 1) {
    const rows = dropTsFossils(await getEditionRows([TS_ID]))
    return buildEditionPages(rows, now)
  }

  // ── Segment 2: AllDay / Golazos / UFC edition pages ───────────────────────
  if (id === 2) {
    const rows = await getEditionRows(EDITION_COLLECTION_IDS.filter((c) => c !== TS_ID))
    return buildEditionPages(rows, now)
  }

  // ── Segment 3: set / player / team entities + top moments ────────────────
  // Derived from the full (fossil-filtered) edition rows, exactly as before.
  if (id === 3) {
    const editions = dropTsFossils(await getEditionRows())

    // /moment/[id] — top 200 by last_updated_at as a coarse popularity proxy.
    const momentPages: MetadataRoute.Sitemap = editions.slice(0, 200).map((e) => ({
      url: `${BASE_URL}/moment/${e.id}`,
      lastModified: e.last_updated_at ? new Date(e.last_updated_at) : now,
      changeFrequency: 'daily' as const,
      priority: 0.65,
    }))

    const setMap = new Map<string, Date>()
    const playerMap = new Map<string, Date>()
    const teamMap = new Map<string, Date>()
    for (const e of editions) {
      const coll = getCollectionByDbSlug(e.collection_db_slug)
      if (!coll) continue
      const ts = e.last_updated_at ? new Date(e.last_updated_at) : now
      if (e.set_name) {
        const k = `${coll.urlSlug}|${slugifyName(e.set_name)}`
        const prev = setMap.get(k)
        if (!prev || ts > prev) setMap.set(k, ts)
      }
      if (e.player_name) {
        const k = `${coll.urlSlug}|${slugifyName(e.player_name)}`
        const prev = playerMap.get(k)
        if (!prev || ts > prev) playerMap.set(k, ts)
      }
      if (e.team_name) {
        const teamSlug = slugifyName(e.team_name)
        // Exhibition / all-star rosters are not real franchises — skip.
        if (!isExhibitionTeamSlug(teamSlug)) {
          const k = `${coll.urlSlug}|${teamSlug}`
          const prev = teamMap.get(k)
          if (!prev || ts > prev) teamMap.set(k, ts)
        }
      }
    }

    function entityPages(map: Map<string, Date>, segment: 'set' | 'player' | 'team', priority: number): MetadataRoute.Sitemap {
      const out: MetadataRoute.Sitemap = []
      for (const [key, ts] of map) {
        const [urlSlug, slug] = key.split('|')
        out.push({
          url: `${BASE_URL}/${urlSlug}/${segment}/${encodeURIComponent(slug)}`,
          lastModified: ts,
          changeFrequency: 'weekly',
          priority,
        })
      }
      return out
    }

    return [
      ...momentPages,
      ...entityPages(setMap, 'set', 0.6),
      ...entityPages(playerMap, 'player', 0.6),
      ...entityPages(teamMap, 'team', 0.55),
    ]
  }

  // ── Segment 4: pack distributions + Pinnacle per-pin pages ────────────────
  if (id === 4) {
    const packRows = await getPackRows()
    const packPages: MetadataRoute.Sitemap = packRows
      .map((p) => {
        const coll = getCollectionByUuid(p.collection_id)
        if (!coll) return null
        return {
          url: `${BASE_URL}/${coll.urlSlug}/pack/dist/${encodeURIComponent(p.dist_id)}`,
          lastModified: p.updated_at ? new Date(p.updated_at) : now,
          changeFrequency: 'weekly' as const,
          priority: 0.5,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)

    const pinnacleRenders = await getPinnacleRenderRows()
    const pinnaclePinPages: MetadataRoute.Sitemap = pinnacleRenders
      .filter((r) => typeof r.render_id === 'string' && r.render_id.length > 0)
      .map((r) => ({
        url: `${BASE_URL}/pinnacle/moment/${encodeURIComponent(r.render_id)}`,
        lastModified: r.updated_at ? new Date(r.updated_at) : now,
        changeFrequency: 'weekly' as const,
        priority: 0.55,
      }))

    return [...packPages, ...pinnaclePinPages]
  }

  // ── Segment 0 (default): static + insights + overviews + series + profiles ─
  const staticPages: MetadataRoute.Sitemap = STATIC_SITEMAP_PAGES.map((e) => ({
    url: e.path === '/' ? BASE_URL : `${BASE_URL}${e.path}`,
    lastModified: now,
    changeFrequency: e.changeFrequency,
    priority: e.priority,
  }))

  const INSIGHT_ROUTES = [
    'squeeze',
    'pack-reality',
    'allday-pack-reality',
    'allday-pack-market',
    'topshot-pack-market',
    'pack-sniper',
    'rookies',
    'rookie-board',
    'first-mint',
    'cross-collection',
    'set-squeeze',
    'pinnacle-scarcity',
    'allday-scarcity',
    'market',
    'offer-spread',
    'deals',
    'trophies',
    'top-sales',
    'serial-premiums',
    'parallel-premiums',
    'market-pulse',
    'new-collectors',
    'set-completers',
    'underpriced-serials',
    'pack-drops',
    'squeeze-check',
    'tc-report',
    'account-value',
    // STAGED surfaces — included only once their launch flag flips, so the
    // sitemap never advertises a URL that proxy.ts 302s to /login (a
    // crawl-budget burn + a "Crawled, currently not indexed" signal). Adding
    // the slug here is NOT a separate go-live step; it rides the launch flag.
    ...(CANDY_MLB_PUBLIC ? ['candy-mlb'] : []),
    ...(PANINI_PUBLIC ? ['panini-squeeze'] : []),
  ]
  const insightsPages: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/insights`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    ...INSIGHT_ROUTES.map((r) => ({
      url: `${BASE_URL}/insights/${r}`,
      lastModified: now,
      changeFrequency: 'daily' as const,
      priority: 0.8,
    })),
  ]

  // Per-collection: /overview plus every anon-public, self-canonical feature tab.
  // Derived per collection from its OWN `pages` array (so a collection that does
  // not ship a tab never gets a URL for it) intersected with PUBLIC_TAB_PAGES.
  // See the corrected header note for why that intersection IS the indexability
  // test and not a convenience.
  const featurePages: MetadataRoute.Sitemap = publishedCollections().flatMap((col) => [
    {
      url: `${BASE_URL}/${col.id}/overview`,
      lastModified: now,
      changeFrequency: 'daily' as const,
      priority: 0.9,
    },
    ...(col.pages ?? [])
      .filter((p) => p !== 'overview' && PUBLIC_TAB_PAGES.includes(p))
      .map((p) => ({
        url: `${BASE_URL}/${col.id}/${p}`,
        lastModified: now,
        // Below /overview (0.9): a tab is what a collector lands on from a
        // query, the overview is the collection front door.
        changeFrequency: 'daily' as const,
        priority: 0.7,
      })),
  ])

  const seriesRows = await getCollectionSeries()
  const seriesPages: MetadataRoute.Sitemap = seriesRows
    .map((r) => {
      const coll = getCollectionByDbSlug(r.collection_db_slug)
      if (!coll) return null
      const slug = slugifyName(r.display_label)
      return {
        url: `${BASE_URL}/${coll.urlSlug}/series/${encodeURIComponent(slug)}`,
        lastModified: r.last_updated_at ? new Date(r.last_updated_at) : now,
        changeFrequency: 'weekly' as const,
        priority: 0.55,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const profiles = await getPublicProfiles()
  const profilePages: MetadataRoute.Sitemap = profiles.map((p) => ({
    url: `${BASE_URL}/profile/${encodeURIComponent(p.username)}`,
    lastModified: p.updated_at ? new Date(p.updated_at) : now,
    changeFrequency: 'weekly' as const,
    priority: 0.5,
  }))

  return [...staticPages, ...insightsPages, ...featurePages, ...seriesPages, ...profilePages]
}
