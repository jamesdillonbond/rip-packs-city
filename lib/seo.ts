import type { Metadata } from 'next'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://rip-packs-city.vercel.app'

// Root layout metadata — import into app/layout.tsx as: export const metadata = rootMetadata
export const rootMetadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: 'Rip Packs City — NBA Top Shot, NFL All Day & Disney Pinnacle Collector Intelligence',
    template: '%s | Rip Packs City',
  },
  description:
    'NBA Top Shot, NFL All Day, LaLiga Golazos, and Disney Pinnacle collectors on Flow blockchain.',
  keywords: [
    'NBA Top Shot',
    'NFL All Day',
    'LaLiga Golazos',
    'Disney Pinnacle',
    'digital pins',
    'FMV',
    'moment value',
    'Top Shot analytics',
    'Flow blockchain',
    'collector tools',
    'sniper deals',
    'pack EV',
    'badge tracker',
  ],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    siteName: 'Rip Packs City',
    images: [{ url: '/og-default.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    creator: '@RipPacksCity',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
}

// JSON-LD structured data — add as <script type="application/ld+json"> in root layout
export const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'Rip Packs City',
  url: BASE_URL,
  description:
    'Collector intelligence platform for NBA Top Shot and NFL All Day on Flow blockchain.',
  applicationCategory: 'FinanceApplication',
  operatingSystem: 'Web',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  creator: {
    '@type': 'Person',
    name: 'Trevor Dillon-Bond',
    url: `${BASE_URL}/profile/jamesdillonbond`,
  },
}

type PageMeta = { title: string; description: string }

// Generic per-page templates — {label} is replaced by the collection's display name.
const PAGE_META: Record<string, PageMeta> = {
  overview: {
    title: '{label} Overview — Market Pulse, Top Sales & Collector Intel',
    description:
      'Daily {label} market pulse: volume, active listings, top sales, and hottest editions for collectors on Flow.',
  },
  collection: {
    title: 'Wallet Analytics — Track Your {label} Collection Value',
    description:
      'Analyze any {label} wallet with real-time FMV, badge detection, serial premiums, and Flowty ask prices.',
  },
  sniper: {
    title: 'Sniper — {label} Deals Below FMV',
    description:
      'Track {label} moments with real-time FMV, sniper deals, and Flowty marketplace intelligence.',
  },
  packs: {
    title: 'Pack Drop Tools — {label} Pack Analysis & EV Calculator',
    description:
      'Browse active and past {label} packs with expected value calculations, pull odds, and buy/skip recommendations.',
  },
  badges: {
    title: 'Badge Tracker — {label} Rookie & Specialty Badges',
    description:
      'Explore {label} badge editions with serial premiums, circulation, and specialty tags.',
  },
  sets: {
    title: 'Set Completion — Track Your {label} Sets',
    description:
      'Track set completion progress, find bottleneck moments, and discover the cheapest path to completing any {label} set.',
  },
  analytics: {
    title: 'Portfolio Analytics — {label} Wallet Breakdown',
    description:
      'Deep-dive wallet analytics for {label}: acquisition origin, tier breakdown, series breakdown, liquid vs locked FMV, and portfolio clarity score.',
  },
  market: {
    title: 'Market Intelligence — {label} Edition Lookup & Leaderboards',
    description:
      'Edition-level market intelligence for {label}: FMV, ask/offer depth, 30-day sales, liquidity and discount leaderboards.',
  },
}

// Per-collection overrides keyed by `${page}:${collectionId}`.
const PAGE_META_OVERRIDES: Record<string, PageMeta> = {
  'badges:nba-top-shot': {
    title: 'Badge Tracker — NBA Top Shot Rookie Year, Top Shot Debut & Championship Year Badges',
    description:
      'Explore NBA Top Shot badge editions: Rookie Year, Top Shot Debut, Championship Year, Fresh, and serial badges with real-time FMV and circulation.',
  },
  'badges:nfl-all-day': {
    title: 'Badge Tracker — NFL All Day Rookie, Playoffs & Super Bowl Badges',
    description:
      'Explore NFL All Day badge editions: Rookie, Playoffs, Super Bowl, Pro Bowl, and First Touchdown badges with real-time FMV and circulation.',
  },
  'badges:laliga-golazos': {
    title: 'Badge Tracker — LaLiga Golazos El Clásico, Ídolos & Estrellas Badges',
    description:
      'Explore LaLiga Golazos badge editions: El Clásico, Eterno Rival, Ídolos, Estrellas, Team Europa, and Tiki Taka with real-time FMV.',
  },
}

export function pageMetadata(page: string, collectionLabel: string, collectionId: string): Metadata {
  const override = PAGE_META_OVERRIDES[`${page}:${collectionId}`]
  const base = PAGE_META[page]
  const meta = override ?? base
  if (!meta) return {}
  const title = meta.title.replace(/\{label\}/g, collectionLabel)
  const description = meta.description.replace(/\{label\}/g, collectionLabel)
  const canonical = `${BASE_URL}/${collectionId}/${page}`
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title: `${title} | Rip Packs City`,
      description,
      url: canonical,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  }
}

// Back-compat wrapper — defaults to NBA Top Shot.
export function collectionPageMetadata(page: string, collectionLabel = 'NBA Top Shot'): Metadata {
  return pageMetadata(page, collectionLabel, 'nba-top-shot')
}

export function profilePageMetadata(username: string): Metadata {
  return {
    title: `${username}'s Collection — NBA Top Shot Portfolio`,
    description: `View ${username}'s NBA Top Shot collection, portfolio value, badges, and set completion on Rip Packs City.`,
    openGraph: {
      title: `${username}'s Collection | Rip Packs City`,
      description: `View ${username}'s NBA Top Shot portfolio and collection analytics.`,
    },
  }
}
