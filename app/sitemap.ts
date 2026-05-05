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
// Deferred — these would multiply the sitemap size but require routes
// that don't exist yet:
//   • per-set pages (347 rows)
//   • per-player pages (1,232 rows)
//   • per-pack pages (5,149 rows in pack_distributions)
// When those route segments are built, plug in the queries here. URLs
// pointing to nonexistent pages would 404 and hurt SEO.
//
// Live as of 2026-04-27:
//   • per-edition pages — every editions row in a published collection.
//     ~20.5K URLs, well under Google's 50K-per-sitemap limit. When the
//     other per-entity segments come online and the total exceeds 50K,
//     split into per-segment sitemap children.

import type { MetadataRoute } from 'next'
import { createClient } from '@supabase/supabase-js'
import { publishedCollections } from '@/lib/collections'
import { listEntityPageCollections, getCollectionByDbSlug } from '@/lib/collection-slug'
import { slugifyName } from '@/lib/entity-labels'
import { METHODOLOGY_LIST } from '@/lib/analytics/methodology'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.rippackscity.com'

// Wallet directory grows slowly — 6h cache keeps the build fast without
// stale wallet entries lingering forever.
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

// DB slugs for collections that have rows in the `editions` table.
// Pinnacle data lives in `pinnacle_editions` (different schema) and is
// excluded from sitemap enumeration here — its entity pages are still
// reachable via in-app navigation and discoverable by GSC after launch.
const EDITION_COLLECTION_DB_SLUGS = [
  'nba_top_shot',
  'nfl_all_day',
  'laliga_golazos',
  'ufc_strike',
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
      .select('id, external_id, last_updated_at, player_name, set_name, team_name, collections!inner(slug)')
      .in('collections.slug', EDITION_COLLECTION_DB_SLUGS)
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
      collections: { slug: string } | null
    }>).map((r) => ({
      id: r.id,
      external_id: r.external_id,
      collection_db_slug: r.collections?.slug ?? '',
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
    const { data, error } = await sb
      .from('collection_series')
      .select('display_label, updated_at, collections!inner(slug)')
      .in('collections.slug', EDITION_COLLECTION_DB_SLUGS)
      .limit(2000)
    if (error) {
      console.log('[sitemap] collection_series query error: ' + error.message)
      return []
    }
    return ((data ?? []) as Array<{
      display_label: string | null
      updated_at: string | null
      collections: { slug: string } | null
    }>)
      .filter((r) => typeof r.display_label === 'string' && r.display_label.length > 0)
      .map((r) => ({
        collection_db_slug: r.collections?.slug ?? '',
        display_label: r.display_label as string,
        last_updated_at: r.updated_at,
      }))
  } catch (err) {
    console.log('[sitemap] collection_series query threw: ' + (err instanceof Error ? err.message : String(err)))
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
    { url: BASE_URL,             lastModified: now, changeFrequency: 'daily',   priority: 1.0 },
    { url: `${BASE_URL}/about`,  lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE_URL}/privacy`,lastModified: now, changeFrequency: 'yearly',  priority: 0.3 },
    { url: `${BASE_URL}/terms`,  lastModified: now, changeFrequency: 'yearly',  priority: 0.3 },
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

  // Touch the unused import so tsc doesn't complain when no entity rows exist.
  void listEntityPageCollections

  return [
    ...staticPages,
    ...featurePages,
    ...analyticsPages,
    ...walletPages,
    ...profilePages,
    ...editionPages,
    ...newSetPages,
    ...newPlayerPages,
    ...newTeamPages,
    ...seriesPages,
    ...legacySetPages,
  ]
}
