// app/sitemap.ts
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
//   • /{collection}/overview — the ONLY anon-public per-collection page. The
//     in-app feature tabs (collection / market / sniper / sets / packs) and the
//     entire /analytics/* section are auth-gated, so they are NOT listed.
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
// Combined, entity + pack URLs total ~33K — under Google's 50K-per-sitemap
// limit. When the total approaches 50K, split into per-segment / per-
// collection sitemap children via a sitemap index.

import type { MetadataRoute } from 'next'
import { createClient } from '@supabase/supabase-js'
import { publishedCollections } from '@/lib/collections'
import { getCollectionByDbSlug, getCollectionByUuid } from '@/lib/collection-slug'
import { slugifyName } from '@/lib/entity-labels'
import { isExhibitionTeamSlug } from '@/lib/team-denylist'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.rippackscity.com'

// Wallet directory grows slowly — 6h cache keeps the build fast without
// stale wallet entries lingering forever.
export const dynamic = 'force-dynamic'
export const revalidate = 21600

async function getPublicProfiles(): Promise<Array<{ username: string; updated_at: string | null }>> {
  // profile_bio.username is the public handle for /profile/[username]. We
  // pull the rows where that's been set so each public profile gets a
  // sitemap entry. Service-role client to bypass RLS — the username column
  // is intentionally public-readable but service role keeps this fast.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return []
  try {
    const sb: any = createClient(url, key)
    const { data, error } = await sb
      .from('profile_bio')
      .select('username, updated_at')
      .not('username', 'is', null)
      .limit(5000)
    if (error) {
      console.log('[sitemap] profile_bio query error: ' + error.message)
      return []
    }
    return (data ?? []) as Array<{ username: string; updated_at: string | null }>
  } catch (err) {
    console.log('[sitemap] profile_bio query threw: ' + (err instanceof Error ? err.message : String(err)))
    return []
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

// PostgREST enforces a hard db-max-rows cap (1000 on this project), so a single
// .limit(50000) silently returns only the first 1000 rows. Page through with
// .range() in 1000-row windows until a short page signals the end. Stable
// ordering is required for correct pagination.
async function fetchAllByCollection(
  sb: any,
  table: string,
  select: string,
  collectionIds: string[],
  orderColumn: string,
  orderAsc: boolean,
  maxRows = 60000,
): Promise<any[]> {
  const PAGE = 1000
  const out: any[] = []
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .in('collection_id', collectionIds)
      .order(orderColumn, { ascending: orderAsc, nullsFirst: false })
      .range(from, from + PAGE - 1)
    if (error) {
      console.log(`[sitemap] ${table} page ${from} error: ` + error.message)
      break
    }
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
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

async function getEditionRows(): Promise<EditionRow[]> {
  // One sitemap entry per edition in a published collection (~23.5K rows
  // today). Service-role client bypasses RLS; paginated via fetchAllByCollection
  // to clear the 1000-row PostgREST cap. We also derive distinct
  // set/player/team slugs from these rows for the entity sitemap entries.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return []
  try {
    const sb: any = createClient(url, key)
    const data = await fetchAllByCollection(
      sb,
      'editions',
      'id, external_id, last_updated_at, player_name, set_name, team_name, collection_id',
      EDITION_COLLECTION_IDS,
      'last_updated_at',
      false,
    )
    return ((data ?? []) as Array<{
      id: string
      external_id: string | null
      last_updated_at: string | null
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
      last_updated_at: r.last_updated_at,
    }))
  } catch (err) {
    console.log('[sitemap] editions query threw: ' + (err instanceof Error ? err.message : String(err)))
    return []
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
  if (!url || !key) return []
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
      console.log('[sitemap] collection_series query error: ' + error.message)
      return []
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
    console.log('[sitemap] collection_series query threw: ' + (err instanceof Error ? err.message : String(err)))
    return []
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
  if (!url || !key) return []
  try {
    const sb: any = createClient(url, key)
    const data = await fetchAllByCollection(
      sb,
      'pack_distributions',
      'dist_id, collection_id, updated_at',
      PACK_COLLECTION_IDS,
      'dist_id',
      true,
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
    console.log('[sitemap] pack_distributions query threw: ' + (err instanceof Error ? err.message : String(err)))
    return []
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
  if (!url || !key) return []
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
        console.log('[sitemap] pinnacle_catalog page ' + from + ' error: ' + error.message)
        break
      }
      const rows = (data ?? []) as PinnacleRenderRow[]
      out.push(...rows)
      if (rows.length < PAGE) break
    }
    return out
  } catch (err) {
    console.log('[sitemap] pinnacle_catalog query threw: ' + (err instanceof Error ? err.message : String(err)))
    return []
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()

  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE_URL,                       lastModified: now, changeFrequency: 'daily',   priority: 1.0 },
    { url: `${BASE_URL}/about`,            lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE_URL}/privacy`,          lastModified: now, changeFrequency: 'yearly',  priority: 0.3 },
    { url: `${BASE_URL}/terms`,            lastModified: now, changeFrequency: 'yearly',  priority: 0.3 },
    { url: `${BASE_URL}/legal/fmv-methodology`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
    { url: `${BASE_URL}/blog`,             lastModified: now, changeFrequency: 'weekly',  priority: 0.5 },
    { url: `${BASE_URL}/blog/permanent-moments-ipfs`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE_URL}/blog/pinnacle-star-wars-day-2026`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    // Public Fast Break optimizer — SEO-targeted, daily refresh.
    { url: `${BASE_URL}/nba/fast-break`,   lastModified: now, changeFrequency: 'daily',   priority: 0.9 },
  ]

  // Public /insights/* wedge surfaces — the distribution thesis. robots.txt
  // allows them and the homepage links them, but they were never advertised
  // to crawlers. Slugs verified against app/insights/*/page.tsx (17 routes).
  const INSIGHT_ROUTES = [
    'squeeze',
    'pack-reality',
    'pack-sniper',
    'rookies',
    'first-mint',
    'cross-collection',
    'set-squeeze',
    'pinnacle-scarcity',
    'market',
    'offer-spread',
    'deals',
    'trophies',
    'top-sales',
    'serial-premiums',
    'underpriced-serials',
    'squeeze-check',
    'tc-report',
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

  // Per-collection: ONLY /<collection>/overview is anon-public (proxy.ts opens
  // the singular-`overview` segment via GET/HEAD). The bare /<collection> root
  // redirects to /overview but is itself gated (so anon crawlers get 302→/login
  // on it), and the in-app feature tabs (collection / market / sniper / sets /
  // packs) are all behind the funnel — none of those are listed. (2026-05-31)
  const featurePages: MetadataRoute.Sitemap = publishedCollections().map((col) => ({
    url: `${BASE_URL}/${col.id}/overview`,
    lastModified: now,
    changeFrequency: 'daily' as const,
    priority: 0.9,
  }))

  // NOTE: /analytics + /analytics/* (sales / loans / fmv / sets / pulse /
  // listings / methodology / wallets) and /analytics/sets/<id> are ALL
  // auth-gated in proxy.ts, so they are intentionally NOT enumerated here.
  // Opening any of them to crawlers is a product decision that would also
  // require an isPublicPath rule — not just a sitemap entry.

  const profiles = await getPublicProfiles()
  const profilePages: MetadataRoute.Sitemap = profiles.map((p) => ({
    url: `${BASE_URL}/profile/${encodeURIComponent(p.username)}`,
    lastModified: p.updated_at ? new Date(p.updated_at) : now,
    changeFrequency: 'weekly' as const,
    priority: 0.5,
  }))

  const allEditions = await getEditionRows()

  // Drop the ~6,404 inert UUID-keyed Top Shot fossil editions. Canonical TS
  // editions are int-pair keyed (`setID:playID`, no hyphen); the fossils are
  // uuid-like (`<uuid>:<uuid>`, has a hyphen) leftovers from the dedup merges,
  // carry NULL on-chain ids / no thumbnail / no FMV, and resolve to thin
  // near-duplicate pages — Google flags them "Duplicate, chose different
  // canonical". Scope the hyphen test to nba_top_shot ONLY: AllDay/Golazos use
  // single-int ids, but UFC's canonical ids are uuid-like (hyphenated), so a
  // global hyphen test would wrongly drop all 446 UFC editions. Filtering the
  // source array here also keeps fossils out of the moment + set/player/team
  // derivations below.
  const editions = allEditions.filter(
    (e) => !(e.collection_db_slug === 'nba_top_shot' && (e.external_id ?? '').includes('-')),
  )

  // Per-edition entries on the new nested route. Old /edition/[uuid] still
  // resolves via a redirect (app/edition/[id]/page.tsx) but the sitemap
  // points to canonical /[collection]/edition/[external_id] URLs.
  const editionPages: MetadataRoute.Sitemap = editions
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

  // /moment/[id] — the cross-collection canonical detail page. Top 200 by
  // last_updated_at as a coarse popularity proxy until we have a real
  // sales_count_30d index to sort by. Kept small for this initial cut to
  // avoid duplicate-URL penalties against the per-collection edition pages
  // above; expand once /moment/[id] becomes the canonical target (with
  // <link rel=canonical> set on both surfaces).
  const momentPages: MetadataRoute.Sitemap = editions
    .slice(0, 200)
    .map((e) => ({
      url: `${BASE_URL}/moment/${e.id}`,
      lastModified: e.last_updated_at ? new Date(e.last_updated_at) : now,
      changeFrequency: 'daily' as const,
      priority: 0.65,
    }))

  // Distinct set / player / team slugs derived from the edition rows above.
  // De-dupe per collection × entity slug; pick the most recent
  // last_updated_at as the lastModified hint.
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
      // Exhibition / all-star rosters (Team LeBron, Rising Stars, …) carry a
      // team_name but are not real franchises — don't advertise their URLs.
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

  const newSetPages = entityPages(setMap, 'set', 0.6)
  const newPlayerPages = entityPages(playerMap, 'player', 0.6)
  const newTeamPages = entityPages(teamMap, 'team', 0.55)

  // Series — one entry per collection_series.display_label.
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

  // Pack distribution pages — /<collection>/pack/dist/<distId>.
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

  // Pinnacle per-pin pages — /pinnacle/moment/<render_id> (render-keyed, Wave 1b).
  const pinnacleRenders = await getPinnacleRenderRows()
  const pinnaclePinPages: MetadataRoute.Sitemap = pinnacleRenders
    .filter((r) => typeof r.render_id === 'string' && r.render_id.length > 0)
    .map((r) => ({
      url: `${BASE_URL}/pinnacle/moment/${encodeURIComponent(r.render_id)}`,
      lastModified: r.updated_at ? new Date(r.updated_at) : now,
      changeFrequency: 'weekly' as const,
      priority: 0.55,
    }))

  return [
    ...staticPages,
    ...insightsPages,
    ...featurePages,
    ...profilePages,
    ...editionPages,
    ...momentPages,
    ...newSetPages,
    ...newPlayerPages,
    ...newTeamPages,
    ...seriesPages,
    ...packPages,
    ...pinnaclePinPages,
  ]
}
