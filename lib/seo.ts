import type { Metadata } from 'next'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://rip-packs-city.vercel.app'

// Root layout metadata — import into app/layout.tsx as: export const metadata = rootMetadata
export const rootMetadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: 'Rip Packs City — NBA Top Shot & NFL All Day Collector Intelligence',
    template: '%s | Rip Packs City',
  },
  description:
    'Real-time FMV, deal sniping, wallet analytics, badge tracking, and pack tools for NBA Top Shot and NFL All Day collectors on Flow blockchain.',
  keywords: [
    'NBA Top Shot',
    'NFL All Day',
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

// Per-page metadata generators — keyed by page, with {label} placeholder for collection name
const PAGE_META: Record<string, { title: string; description: string }> = {
  collection: {
    title: 'Wallet Analytics — Track Your {label} Collection Value',
    description:
      'Analyze any {label} wallet with real-time FMV, badge detection, serial premiums, and Flowty ask prices.',
  },
  sniper: {
    title: 'Sniper — {label}',
    description:
      'Track {label} moments with real-time FMV, sniper deals, and Flowty marketplace intelligence.',
  },
  packs: {
    title: 'Pack Drop Tools — {label} Pack Analysis & EV Calculator',
    description:
      'Browse active and past {label} packs with expected value calculations, pull odds, and buy/skip recommendations.',
  },
  badges: {
    title: 'Badge Tracker — Rookie Year, Top Shot Debut & More',
    description:
      'Explore {label} badge editions including Top Shot Debut, Rookie Year, Championship, and serial badges.',
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

export function collectionPageMetadata(page: string, collectionLabel = 'NBA Top Shot'): Metadata {
  const meta = PAGE_META[page]
  if (!meta) return {}
  const title = meta.title.replace(/\{label\}/g, collectionLabel)
  const description = meta.description.replace(/\{label\}/g, collectionLabel)
  return {
    title,
    description,
    openGraph: {
      title: `${title} | Rip Packs City`,
      description,
    },
  }
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
