// app/sitemap.ts
//
// Enumerates every indexable URL on the site for search-engine crawlers.
// Currently covers:
//   • root + static pages (about, privacy, terms)
//   • /{collection}/{page} for every published collection × every page
//     listed on that Collection (overview, collection, market, analytics,
//     sniper, sets, packs)
//   • /analytics + /analytics/{section} including methodology
//   • /analytics/loans/{collection} per-collection drill-downs
//   • /analytics/wallets/{address} for every active Flowty wallet
//   • /profile/{username} for each profile_bio row that has set a public
//     username (Phase 4 public profile pages)
//
// Entity + pack pages are now enumerated (the routes exist and render for
// anon — see proxy.ts public-entity-path rule):
//   • per-edition pages — every editions row in a published collection (~23.5K)
//   • per-set / per-player / per-team pages — distinct slugs derived from
//     those edition rows
//   • per-series pages — one per collection_series.display_label (~28)
//   • per-pack pages — every pack_distributions row (~5.2K)
//
// Edition collections are filtered by collection_id directly (not via a
// PostgREST embedded join on collections.slug, which returned 0 rows at
// generation time). collection_series carries NO timestamp column, so its
// entries use `now` for lastModified.
//
// Combined, entity + pack URLs total ~29K — under Google's 50K-per-sitemap
// limit. When the total approaches 50K, split into per-segment / per-
// collection sitemap children via a sitemap index.

import type { MetadataRoute } from 'next'
import { createClient } from '@supabase/supabase-js'
import { publishedCollections } from '@/lib/collections'
import { listEntityPageCollections, getCollectionByDbSlug, getCollectionByUuid } from '@/lib/collection-slug'
import { slugifyName } from '@/lib/entity-labels'
import { METHODOLOGY_LIST } from '@/lib/analytics/methodology'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.rippackscity.com'

// Wallet directory grows slowly — 6h cache keeps the build fast without
// stale wallet entries lingering forever.
export const dynamic = 'force-dynamic'
export const revalidate = 21600

const ANALYTICS_STUBS = [
  'wallets',
  'packs',
  'api',
]

const LOAN_COLLECTION_SLUGS = ['topshot', 'allday', 'golazos', 'pinnacle', 'ufc']
const SALES_COLLECTION_SLUGS = ['topshot', 'allday', 'golazos', 'pinnacle', 'ufc']

// Per-page change frequency + priority. Market/analytics/sniper change
// constantly; static pages are stable.
const PAGE_FREQ: Record<string, NonNullable<MetadataRoute.Sitemap[number]['changeFrequency']>> = {
  overview:   'daily',
  market:     'daily',
  analytics:  'daily',
  sniper:     'hourly',
  packs:      'daily',
  collection: 'weekly',
  sets:       'weekly',
  vault:      'weekly',
}

const PAGE_PRIORITY: Record<string, number> = {
  overview:   0.9,
  market:     0.8,
  analytics:  0.8,
  sniper:     0.8,
  collection: 0.7,
  packs:      0.7,
  sets:       0.6,
  vault:      0.5,
}

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

interface DirectoryRow {
  addr: string
  last_active_at: string | null
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
  // One sitemap entry per edition in a published collection. Service-role
  // client bypasses RLS; the join is materialised by Supabase via the
  // foreign-key relation. ~20.5K rows total today.
  //
  // We also derive distinct set/player/team slugs from these rows for the
  // entity sitemap entries — keeps the build-time query count to one.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return []
  try {
    const sb: any = createClient(url, key)
    const { data, error } = await sb
      .from('editions')
      .select('id, external_id, last_updated_at, player_name, set_name, team_name, collection_id')
      .in('collection_id', EDITION_COLLECTION_IDS)
      .order('last_updated_at', { ascending: false, nullsFirst: false })
      .limit(50000)
    if (error) {
      console.log('[sitemap] editions query error: ' + error.message)
      return []
    }
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
    const { data, error } = await sb
      .from('pack_distributions')
      .select('dist_id, collection_id, updated_at')
      .in('collection_id', PACK_COLLECTION_IDS)
      .limit(10000)
    if (error) {
      console.log('[sitemap] pack_distributions query error: ' + error.message)
      return []
    }
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

interface TopSetRow {
  set_id: string
  total_fmv_robust_usd: number
}

async function getTopSets(): Promise<TopSetRow[]> {
  // Pre-render-friendly URL list of the top-100 sets by robust total FMV.
  // The /analytics/sets/[set_id] route uses ISR with revalidate=21600;
  // sitemap entries here ensure the top sets are crawlable from the
  // sitemap index.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return []
  try {
    const sb: any = createClient(url, key)
    const { data, error } = await sb.rpc('analytics_sets_directory', {
      p_collections: null,
      p_sort: 'value_desc',
      p_min_coverage: 0,
      p_limit: 100,
    })
    if (error || !Array.isArray(data)) {
      if (error) console.log('[sitemap] sets_directory error: ' + error.message)
      return []
    }
    return (data as TopSetRow[]).filter(
      (r) => typeof r.set_id === 'string' && r.set_id.length === 36
    )
  } catch (err) {
    console.log('[sitemap] sets_directory threw: ' + (err instanceof Error ? err.message : String(err)))
    return []
  }
}

async function getLoanWallets(): Promise<DirectoryRow[]> {
  // Every wallet that's appeared on the Flowty loan book gets one
  // /analytics/wallets/[address] entry. We use the canonical
  // flowty_analytics_wallet_directory RPC — same source the directory
  // page reads — so the sitemap can never disagree with the live UI.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return []
  try {
    const sb: any = createClient(url, key)
    const { data, error } = await sb.rpc('flowty_analytics_wallet_directory')
    if (error) {
      console.log('[sitemap] wallet_directory error: ' + error.message)
      return []
    }
    return ((data ?? []) as DirectoryRow[]).filter((r) => /^0x[0-9a-f]{16}$/i.test(r.addr || ''))
  } catch (err) {
    console.log('[sitemap] wallet_directory threw: ' + (err instanceof Error ? err.message : String(err)))
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
    // Public Fast Break optimizer — SEO-targeted, daily refresh.
    { url: `${BASE_URL}/nba/fast-break`,   lastModified: now, changeFrequency: 'daily',   priority: 0.9 },
  ]

  // Public /insights/* wedge surfaces — the distribution thesis. robots.txt
  // allows them and the homepage links them, but they were never advertised
  // to crawlers. Slugs verified against app/insights/*/page.tsx (9 routes).
  const INSIGHT_ROUTES = [
    'squeeze',
    'pack-reality',
    'rookies',
    'first-mint',
    'cross-collection',
    'set-squeeze',
    'pinnacle-scarcity',
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

  const featurePages: MetadataRoute.Sitemap = publishedCollections().flatMap((col) => [
    {
      url: `${BASE_URL}/${col.id}`,
      lastModified: now,
      changeFrequency: 'daily',
      priority: 0.9,
    },
    ...col.pages.map((page) => ({
      url: `${BASE_URL}/${col.id}/${page}`,
      lastModified: now,
      changeFrequency: PAGE_FREQ[page] ?? 'weekly',
      priority: PAGE_PRIORITY[page] ?? 0.6,
    })),
  ])

  const analyticsPages: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/analytics`,       lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${BASE_URL}/analytics/loans`, lastModified: now, changeFrequency: 'daily', priority: 0.8 },
    ...LOAN_COLLECTION_SLUGS.map((slug) => ({
      url: `${BASE_URL}/analytics/loans/${slug}`,
      lastModified: now,
      changeFrequency: 'daily' as const,
      priority: 0.7,
    })),
    { url: `${BASE_URL}/analytics/sales`, lastModified: now, changeFrequency: 'daily', priority: 0.8 },
    ...SALES_COLLECTION_SLUGS.map((slug) => ({
      url: `${BASE_URL}/analytics/sales/${slug}`,
      lastModified: now,
      changeFrequency: 'daily' as const,
      priority: 0.7,
    })),
    { url: `${BASE_URL}/analytics/pulse`, lastModified: now, changeFrequency: 'always', priority: 0.9 },
    { url: `${BASE_URL}/analytics/listings`, lastModified: now, changeFrequency: 'hourly', priority: 0.8 },
    { url: `${BASE_URL}/analytics/fmv`, lastModified: now, changeFrequency: 'daily', priority: 0.7 },
    { url: `${BASE_URL}/analytics/sets`, lastModified: now, changeFrequency: 'weekly', priority: 0.7 },
    ...ANALYTICS_STUBS.map((slug) => ({
      url: `${BASE_URL}/analytics/${slug}`,
      lastModified: now,
      changeFrequency: 'weekly' as const,
      priority: 0.6,
    })),
    {
      url: `${BASE_URL}/analytics/methodology`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    ...METHODOLOGY_LIST.map((m) => ({
      url: `${BASE_URL}/analytics/methodology/${m.slug}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    })),
  ]

  const loanWallets = await getLoanWallets()
  const walletPages: MetadataRoute.Sitemap = loanWallets.map((w) => ({
    url: `${BASE_URL}/analytics/wallets/${w.addr}`,
    lastModified: w.last_active_at ? new Date(w.last_active_at) : now,
    changeFrequency: 'weekly' as const,
    priority: 0.6,
  }))

  const profiles = await getPublicProfiles()
  const profilePages: MetadataRoute.Sitemap = profiles.map((p) => ({
    url: `${BASE_URL}/profile/${encodeURIComponent(p.username)}`,
    lastModified: p.updated_at ? new Date(p.updated_at) : now,
    changeFrequency: 'weekly' as const,
    priority: 0.5,
  }))

  const editions = await getEditionRows()

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
      const k = `${coll.urlSlug}|${slugifyName(e.team_name)}`
      const prev = teamMap.get(k)
      if (!prev || ts > prev) teamMap.set(k, ts)
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

  const topSets = await getTopSets()
  const legacySetPages: MetadataRoute.Sitemap = topSets.map((s) => ({
    url: `${BASE_URL}/analytics/sets/${s.set_id}`,
    lastModified: now,
    changeFrequency: 'weekly' as const,
    priority: 0.5,
  }))

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

  // Touch the unused import so tsc doesn't complain when no entity rows exist.
  void listEntityPageCollections

  return [
    ...staticPages,
    ...insightsPages,
    ...featurePages,
    ...analyticsPages,
    ...walletPages,
    ...profilePages,
    ...editionPages,
    ...momentPages,
    ...newSetPages,
    ...newPlayerPages,
    ...newTeamPages,
    ...seriesPages,
    ...legacySetPages,
    ...packPages,
  ]
}
