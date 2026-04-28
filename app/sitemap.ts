// app/sitemap.ts
//
// Enumerates every indexable URL on the site for search-engine crawlers.
// Currently covers:
//   • root + static pages (about, privacy, terms)
//   • /{collection}/{page} for every published collection × every page
//     listed on that Collection (overview, collection, market, analytics,
//     sniper, badges, sets, packs)
//   • /analytics + /analytics/{section} including methodology
//   • /analytics/loans/{collection} per-collection drill-downs
//   • /analytics/wallets/{address} for every active Flowty wallet
//   • /profile/{username} for each profile_bio row that has set a public
//     username (Phase 4 public profile pages)
//
// Deferred — these would 5x the sitemap size but require routes that
// don't exist yet:
//   • per-edition pages (~20K rows)
//   • per-set pages (347 rows)
//   • per-player pages (1,232 rows)
//   • per-pack pages (5,149 rows in pack_distributions)
// When those route segments are built, plug in the queries here. URLs
// pointing to nonexistent pages would 404 and hurt SEO.

import type { MetadataRoute } from 'next'
import { createClient } from '@supabase/supabase-js'
import { publishedCollections } from '@/lib/collections'
import { METHODOLOGY_LIST } from '@/lib/analytics/methodology'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://rip-packs-city.vercel.app'

// Wallet directory grows slowly — 6h cache keeps the build fast without
// stale wallet entries lingering forever.
export const revalidate = 21600

const ANALYTICS_STUBS = [
  'pulse',
  'listings',
  'wallets',
  'packs',
  'sets',
  'fmv',
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
  badges:     'weekly',
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
  badges:     0.6,
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

  return [
    ...staticPages,
    ...featurePages,
    ...analyticsPages,
    ...walletPages,
    ...profilePages,
  ]
}
