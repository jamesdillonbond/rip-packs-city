import type { Metadata } from 'next'

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.rippackscity.com'

// Root layout metadata — import into app/layout.tsx as: export const metadata = rootMetadata
// Home (/) inherits these directly \u2014 the marketing page does not export its
// own metadata, so default title, description, openGraph, and twitter all
// describe the home surface. The %s template below still applies per-subpage.
const ROOT_TITLE =
  'Rip Packs City \u2014 The Intelligence Layer for Flow Collectibles'
const ROOT_DESCRIPTION =
  'Real-time FMV, deal sniping, wallet analytics, badge tracking, pack tools, and set intelligence for NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga Golazos, and UFC Strike collectors on Flow blockchain.'

export const rootMetadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: ROOT_TITLE,
    template: '%s | Rip Packs City',
  },
  description: ROOT_DESCRIPTION,
  keywords: [
    'NBA Top Shot',
    'NFL All Day',
    'LaLiga Golazos',
    'Disney Pinnacle',
    'UFC Strike',
    'UFC NFT',
    'soccer NFT',
    'digital pins',
    'FMV',
    'moment value',
    'Top Shot analytics',
    'Flow blockchain',
    'collector tools',
    'sniper deals',
    'pack EV',
    'pack EV calculator',
    'badge filters',
  ],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    siteName: 'Rip Packs City',
    title: ROOT_TITLE,
    description: ROOT_DESCRIPTION,
    images: [{ url: '/api/og/default', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    creator: '@RipPacksCity',
    title: ROOT_TITLE,
    description: ROOT_DESCRIPTION,
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
    'Collector intelligence platform for NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga Golazos, and UFC Strike on Flow blockchain.',
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
// Descriptions stay cross-collection-friendly: any Flow blockchain wallet across
// Top Shot, All Day, Pinnacle, Golazos, and UFC funnels through these helpers.
const PAGE_META: Record<string, PageMeta> = {
  overview: {
    title: '{label} Overview — Market Pulse, Top Sales & Collector Intel',
    description:
      'Daily {label} market pulse on Flow: volume, active listings, top sales, hottest editions, and pipeline health for collectors.',
  },
  collection: {
    title: 'Wallet Analytics — Track Your {label} Collection Value',
    description:
      'Analyze any Flow blockchain wallet across Top Shot, All Day, Pinnacle, Golazos, and UFC — real-time FMV, badge detection, serial premiums, and marketplace ask prices for {label}.',
  },
  sniper: {
    title: 'Sniper — {label} Deals Below FMV',
    description:
      'Live deals below FMV across Top Shot, All Day, Pinnacle, Golazos, and UFC. Real-time FMV, marketplace intelligence, and per-edition discount scoring for {label}.',
  },
  packs: {
    title: 'Pack Drop Tools — {label} Pack Analysis & EV Calculator',
    description:
      'Pack EV calculator for Flow drops across Top Shot, All Day, and Golazos: expected value, pull odds, and buy/skip recommendations for active and past {label} packs.',
  },
  badges: {
    title: 'Badge Tracker — {label} Top Shot Debut, Rookie Year & Championship Premiums',
    description:
      'Detect badge-eligible moments on any Flow blockchain wallet and track {label} premiums for Top Shot Debut, Fresh, Rookie Year, Championship, and more across the ecosystem.',
  },
  sets: {
    title: 'Set Completion — Track Your {label} Sets',
    description:
      'Set completion progress, bottleneck moments, and the cheapest path to finishing any {label} set across Flow blockchain collections.',
  },
  analytics: {
    title: 'Portfolio Analytics — {label} Wallet Breakdown',
    description:
      'Deep-dive wallet analytics across Top Shot, All Day, Pinnacle, Golazos, and UFC: acquisition origin, tier and series breakdown, liquid vs locked FMV, and portfolio clarity score for {label}.',
  },
  market: {
    title: 'Market Intelligence — {label} Edition Lookup & Leaderboards',
    description:
      'Edition-level market intelligence for {label}: FMV, ask/offer depth, 30-day sales, and liquidity and discount leaderboards across the Flow blockchain ecosystem.',
  },
}

// Per-collection overrides keyed by `${page}:${collectionId}`.
const PAGE_META_OVERRIDES: Record<string, PageMeta> = {}

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

// Per-collection layout metadata (used by [collection]/layout.tsx).
const COLLECTION_LAYOUT_META: Record<string, PageMeta> = {
  'nba-top-shot': {
    title: 'NBA Top Shot Analytics — Rip Packs City',
    description:
      'Real-time FMV pricing, deal sniper, pack EV calculator, and collection analytics for NBA Top Shot collectors on Flow blockchain.',
  },
  'nfl-all-day': {
    title: 'NFL All Day Analytics — Rip Packs City',
    description:
      'Wallet analysis, FMV pricing, set tracking, and marketplace intelligence for NFL All Day collectors on Flow blockchain.',
  },
  'laliga-golazos': {
    title: 'LaLiga Golazos Analytics — Rip Packs City',
    description:
      'Wallet analysis, FMV pricing, set tracking, and marketplace intelligence for LaLiga Golazos collectors on Flow blockchain.',
  },
  'disney-pinnacle': {
    title: 'Disney Pinnacle Analytics — Rip Packs City',
    description:
      'Digital pin analytics, variant tracking, FMV pricing, and marketplace intelligence for Disney Pinnacle collectors on Flow blockchain.',
  },
  'ufc': {
    title: 'UFC Strike Analytics — Rip Packs City',
    description:
      'FMV pricing, sniper deals, and wallet analytics for UFC Strike moments. Collection migrated to Aptos; 247 NFTs indexed on Flow.',
  },
}

const COLLECTION_LABELS: Record<string, string> = {
  'nba-top-shot': 'NBA Top Shot',
  'nfl-all-day': 'NFL All Day',
  'laliga-golazos': 'LaLiga Golazos',
  'disney-pinnacle': 'Disney Pinnacle',
  'ufc': 'UFC Strike',
  'panini-blockchain': 'Panini Blockchain',
}

export function collectionLayoutMetadata(collectionId: string): Metadata {
  const meta = COLLECTION_LAYOUT_META[collectionId] ?? {
    title: 'Rip Packs City — Collector Intelligence',
    description:
      'The smartest analytics platform for NBA Top Shot and NFL All Day collectors. FMV pricing, set intelligence, pack EV, and a live marketplace sniper.',
  }
  const canonical = `${BASE_URL}/${collectionId}`
  const label = COLLECTION_LABELS[collectionId] ?? 'Flow'
  // Per-collection OG image. /api/og/collection?id=<slug> renders a
  // 1200×630 card branded with the collection's icon, label, accent
  // color, and chain pill. Returns the generic fallback for unknown ids.
  const ogImage = `${BASE_URL}/api/og/collection?id=${collectionId}`
  return {
    title: meta.title,
    description: meta.description,
    alternates: { canonical },
    keywords: [label, 'FMV', 'moment value', 'collector tools', 'sniper deals', 'Flow blockchain'],
    openGraph: {
      title: meta.title,
      description: meta.description,
      url: canonical,
      siteName: 'Rip Packs City',
      type: 'website',
      images: [{ url: ogImage, width: 1200, height: 630, alt: label }],
    },
    twitter: {
      card: 'summary_large_image',
      title: meta.title,
      description: meta.description,
      site: '@rippackscity',
      images: [ogImage],
    },
  }
}

// JSON-LD CollectionPage schema for /[collection]/* pages. Includes a
// minimal BreadcrumbList so Google can render the path-trail rich result.
export function collectionPageJsonLd(collectionId: string): object {
  const label = COLLECTION_LABELS[collectionId] ?? collectionId
  const url = `${BASE_URL}/${collectionId}`
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': url,
        url,
        name: `${label} on Rip Packs City`,
        description:
          COLLECTION_LAYOUT_META[collectionId]?.description ??
          `Collector intelligence for ${label}.`,
        isPartOf: { '@type': 'WebSite', name: 'Rip Packs City', url: BASE_URL },
        breadcrumb: { '@id': `${url}#breadcrumb` },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: BASE_URL },
          { '@type': 'ListItem', position: 2, name: label, item: url },
        ],
      },
    ],
  }
}

// Multi-collection page metadata. Accepts a collection ID and resolves the label.
export function collectionPageMetadata(page: string, collectionId = 'nba-top-shot'): Metadata {
  const label = COLLECTION_LABELS[collectionId] ?? 'Flow'
  return pageMetadata(page, label, collectionId)
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

// ── Phase 1A: Entity-detail metadata helpers ────────────────────────────────
// editionPageMetadata, setPageMetadata, playerPageMetadata, teamPageMetadata,
// and seriesPageMetadata all accept the URL collection slug + the relevant
// detail RPC payload and return a Next.js Metadata object with:
//   - title in the format "<Subject> — <Context> | <Collection> | Rip Packs City"
//   - description summarizing the entity
//   - openGraph.images using whatever thumbnail/portrait is available
//   - twitter card type "summary_large_image"
//   - canonical URL set to the absolute hyphenated path
//
// Inputs are typed loosely (Record<string, unknown>) so they accept the RPC
// payloads directly without each helper needing to import a full type.

type Payload = Record<string, unknown>

const COLLECTION_DISPLAY_NAMES: Record<string, string> = {
  "nba-top-shot": "NBA Top Shot",
  "nfl-all-day": "NFL All Day",
  "laliga-golazos": "LaLiga Golazos",
  "disney-pinnacle": "Disney Pinnacle",
  "ufc": "UFC Strike",
}

function s(p: Payload, k: string): string | null {
  const v = p[k]
  return typeof v === "string" && v.length > 0 ? v : null
}

function n(p: Payload, k: string): number | null {
  const v = p[k]
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const parsed = Number(v)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function fmtUsd(value: number | null): string | null {
  if (value === null) return null
  if (value >= 100) return `$${Math.round(value).toLocaleString()}`
  return `$${value.toFixed(2)}`
}

function fmtCount(value: number | null): string | null {
  return value === null ? null : value.toLocaleString()
}

function buildMeta(opts: {
  title: string
  description: string
  canonical: string
  image?: string | null
}): Metadata {
  const image = opts.image ?? "/api/og/default"
  return {
    title: opts.title,
    description: opts.description,
    alternates: { canonical: opts.canonical },
    openGraph: {
      title: opts.title,
      description: opts.description,
      url: opts.canonical,
      siteName: "Rip Packs City",
      type: "website",
      images: [{ url: image, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: opts.title,
      description: opts.description,
      images: image ? [image] : undefined,
    },
  }
}

// Top Shot on-chain series number (UInt32) -> display name, per the series map
// in CLAUDE.md. get_edition_detail returns series_label as the bare on-chain
// number (e.g. "7"), so a naked "7." in a meta description reads as a dangling
// fragment. There is no on-chain series=1 (series 0 IS Series 1) and no "Beta".
const TS_SERIES_DISPLAY: Record<string, string> = {
  "0": "Series 1",
  "2": "Series 2",
  "3": "Summer 2021",
  "4": "Series 3",
  "5": "Series 4",
  "6": "Series 2023-24",
  "7": "Series 2024-25",
  "8": "Series 2025-26",
}

// Render the series label as a readable phrase. For Top Shot a bare on-chain
// number maps to its display name; any other numeric label becomes "Series N";
// a non-numeric label (already a phrase) is returned as-is.
function formatSeriesLabel(label: string, collectionUrlSlug: string): string {
  const trimmed = label.trim()
  if (/^\d+$/.test(trimmed)) {
    if (collectionUrlSlug === "nba-top-shot" && TS_SERIES_DISPLAY[trimmed]) {
      return TS_SERIES_DISPLAY[trimmed]
    }
    return `Series ${trimmed}`
  }
  return trimmed
}

/**
 * Edition detail page. Expects a payload with route_slug + name fields and
 * optionally fmv.fmv_usd. Pinnacle payloads carry the same fields.
 */
export function editionPageMetadata(payload: Payload, collectionUrlSlug: string): Metadata {
  const collectionLabel = COLLECTION_DISPLAY_NAMES[collectionUrlSlug] ?? "Flow"
  const routeSlug = s(payload, "route_slug") ?? s(payload, "external_id") ?? ""
  const playerName = s(payload, "player_name") ?? s(payload, "name") ?? "Edition"
  const setName = s(payload, "set_name") ?? "Edition"
  const tier = s(payload, "tier")
  const seriesLabel = s(payload, "series_label")
  const circulation = n(payload, "circulation_count")
  const thumbnail = s(payload, "thumbnail_url")
  const fmvObj = (payload.fmv as Payload | null | undefined) ?? null
  const fmvUsd = fmvObj ? n(fmvObj, "fmv_usd") : null
  const subject = playerName
  const context = setName
  const title = `${subject} — ${context} | ${collectionLabel} | Rip Packs City`
  const descParts = [
    `${subject} (${setName}) — ${collectionLabel} edition.`,
    tier ? `Tier ${tier}.` : null,
    seriesLabel ? `${formatSeriesLabel(seriesLabel, collectionUrlSlug)}.` : null,
    circulation ? `Circulation ${fmtCount(circulation)}.` : null,
    fmvUsd ? `Current FMV ${fmtUsd(fmvUsd)}.` : null,
    "Live FMV, recent sales, history chart, and packs that contained this edition.",
  ].filter(Boolean) as string[]
  const description = descParts.join(" ")
  const canonical = `${BASE_URL}/${collectionUrlSlug}/edition/${encodeURIComponent(routeSlug)}`
  const og = routeSlug
    ? `${BASE_URL}/api/og/edition?collection=${collectionUrlSlug}&slug=${encodeURIComponent(routeSlug)}`
    : thumbnail
  return buildMeta({ title, description, canonical, image: og })
}

/**
 * Set detail page. Expects a payload with set_name (canonical) plus aggregate
 * fields. The slug is provided separately because the canonical set_name can
 * contain whitespace and unicode that should NOT roundtrip through encoding.
 */
export function setPageMetadata(
  payload: Payload,
  collectionUrlSlug: string,
  setSlug: string,
): Metadata {
  const collectionLabel = COLLECTION_DISPLAY_NAMES[collectionUrlSlug] ?? "Flow"
  const setName = s(payload, "set_name") ?? "Set"
  const editionCount = n(payload, "edition_count")
  const totalCirc = n(payload, "total_circulation")
  const fmvTotal = n(payload, "fmv_total_usd")
  const title = `${setName} — Set | ${collectionLabel} | Rip Packs City`
  const descParts = [
    `${setName} on ${collectionLabel}.`,
    editionCount ? `${fmtCount(editionCount)} editions.` : null,
    totalCirc ? `${fmtCount(totalCirc)} total circulation.` : null,
    fmvTotal ? `Aggregate FMV ${fmtUsd(fmvTotal)}.` : null,
    "Tier mix, edition grid, and player breakdown.",
  ].filter(Boolean) as string[]
  const description = descParts.join(" ")
  const canonical = `${BASE_URL}/${collectionUrlSlug}/set/${encodeURIComponent(setSlug)}`
  const og = setSlug ? `${BASE_URL}/api/og/set?collection=${collectionUrlSlug}&slug=${encodeURIComponent(setSlug)}` : null
  return buildMeta({ title, description, canonical, image: og })
}

/**
 * Player (or character, on Pinnacle) detail page.
 */
export function playerPageMetadata(
  payload: Payload,
  collectionUrlSlug: string,
  playerSlug: string,
): Metadata {
  const collectionLabel = COLLECTION_DISPLAY_NAMES[collectionUrlSlug] ?? "Flow"
  const isCharacter = payload["is_character"] === true
  const noun = isCharacter ? "Character" : "Player"
  const name = s(payload, "name") ?? "Player"
  const team = s(payload, "team")
  const editionCount = n(payload, "edition_count")
  const fmvTotal = n(payload, "fmv_total_usd")
  const headshot = s(payload, "headshot_url")
  const teamLabel = isCharacter ? "Franchise" : "Team"
  const title = `${name} — ${noun} | ${collectionLabel} | Rip Packs City`
  const descParts = [
    `${name} (${noun}) on ${collectionLabel}.`,
    team ? `${teamLabel}: ${team}.` : null,
    editionCount ? `${fmtCount(editionCount)} editions.` : null,
    fmvTotal ? `Portfolio FMV ${fmtUsd(fmvTotal)}.` : null,
    "Edition grid, top sale, and set breakdown.",
  ].filter(Boolean) as string[]
  const description = descParts.join(" ")
  const canonical = `${BASE_URL}/${collectionUrlSlug}/player/${encodeURIComponent(playerSlug)}`
  const og = playerSlug
    ? `${BASE_URL}/api/og/player?collection=${collectionUrlSlug}&slug=${encodeURIComponent(playerSlug)}`
    : headshot
  return buildMeta({ title, description, canonical, image: og })
}

/**
 * Team (or franchise, on Pinnacle) detail page.
 */
export function teamPageMetadata(
  payload: Payload,
  collectionUrlSlug: string,
  teamSlug: string,
): Metadata {
  const collectionLabel = COLLECTION_DISPLAY_NAMES[collectionUrlSlug] ?? "Flow"
  const isFranchise = payload["is_franchise"] === true
  const noun = isFranchise ? "Franchise" : "Team"
  const teamName = s(payload, "team_name") ?? "Team"
  const playerCount = n(payload, "player_count")
  const editionCount = n(payload, "edition_count")
  const fmvTotal = n(payload, "fmv_total_usd")
  const title = `${teamName} — ${noun} | ${collectionLabel} | Rip Packs City`
  const descParts = [
    `${teamName} ${noun.toLowerCase()} on ${collectionLabel}.`,
    playerCount ? `${fmtCount(playerCount)} ${isFranchise ? "characters" : "players"}.` : null,
    editionCount ? `${fmtCount(editionCount)} editions.` : null,
    fmvTotal ? `Aggregate FMV ${fmtUsd(fmvTotal)}.` : null,
    isFranchise ? "Cast grid and franchise breakdown." : "Roster grid and team breakdown.",
  ].filter(Boolean) as string[]
  const description = descParts.join(" ")
  const canonical = `${BASE_URL}/${collectionUrlSlug}/team/${encodeURIComponent(teamSlug)}`
  const og = teamSlug ? `${BASE_URL}/api/og/team?collection=${collectionUrlSlug}&slug=${encodeURIComponent(teamSlug)}` : null
  return buildMeta({ title, description, canonical, image: og })
}

/**
 * Series detail page.
 */
export function seriesPageMetadata(
  payload: Payload,
  collectionUrlSlug: string,
  seriesSlug: string,
): Metadata {
  const collectionLabel = COLLECTION_DISPLAY_NAMES[collectionUrlSlug] ?? "Flow"
  const displayLabel = s(payload, "display_label") ?? "Series"
  const season = s(payload, "season")
  const editionCount = n(payload, "edition_count")
  const setCount = n(payload, "set_count")
  const playerCount = n(payload, "player_count")
  const fmvTotal = n(payload, "fmv_total_usd")
  const subject = displayLabel
  const context = season ? `Season ${season}` : "Series"
  const title = `${subject} — ${context} | ${collectionLabel} | Rip Packs City`
  const descParts = [
    `${displayLabel} on ${collectionLabel}.`,
    season ? `Season ${season}.` : null,
    editionCount ? `${fmtCount(editionCount)} editions.` : null,
    setCount ? `${fmtCount(setCount)} sets.` : null,
    playerCount ? `${fmtCount(playerCount)} players.` : null,
    fmvTotal ? `Aggregate FMV ${fmtUsd(fmvTotal)}.` : null,
    "Top editions, set breakdown, and player leaderboard.",
  ].filter(Boolean) as string[]
  const description = descParts.join(" ")
  const canonical = `${BASE_URL}/${collectionUrlSlug}/series/${encodeURIComponent(seriesSlug)}`
  const og = seriesSlug ? `${BASE_URL}/api/og/series?collection=${collectionUrlSlug}&slug=${encodeURIComponent(seriesSlug)}` : null
  return buildMeta({ title, description, canonical, image: og })
}

// ── Phase 2B: Entity JSON-LD structured data ─────────────────────────────────
// One <script type="application/ld+json"> per entity page, rendered server-side
// in the page body. These return plain objects; the page stringifies them.
// The detail RPCs already carry every field below — no DB change. BASE_URL and
// COLLECTION_DISPLAY_NAMES are module-private above; these helpers reuse them.

type LdValue = Record<string, unknown>

// Public accessor for the collection display name used across entity
// breadcrumbs + JSON-LD (COLLECTION_DISPLAY_NAMES is module-private).
export function collectionDisplayName(collectionUrlSlug: string): string {
  return COLLECTION_DISPLAY_NAMES[collectionUrlSlug] ?? "Flow"
}

export function breadcrumbJsonLd(items: { name: string; url: string }[]): LdValue {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: it.url })),
  }
}

// Edition → Product (+ BreadcrumbList). detail = get_edition_detail payload.
// lowAsk (edition_offers.low_ask, threaded from the page) lets NO_DATA editions
// still satisfy the Product-snippet "offers/review/aggregateRating" requirement.
export function editionJsonLd(detail: Payload, collectionUrlSlug: string, lowAsk?: number | null): LdValue {
  const label = COLLECTION_DISPLAY_NAMES[collectionUrlSlug] ?? "Flow"
  const slug = s(detail, "route_slug") ?? s(detail, "external_id") ?? ""
  const url = `${BASE_URL}/${collectionUrlSlug}/edition/${encodeURIComponent(slug)}`
  const fmvObj = (detail.fmv as Payload | null | undefined) ?? null
  const fmv = fmvObj ? n(fmvObj, "fmv_usd") : null
  const fmvConfidence = fmvObj ? s(fmvObj, "confidence") : null
  const setName = s(detail, "set_name")
  const setSlug = s(detail, "set_slug")
  const playerName = s(detail, "player_name") ?? s(detail, "name") ?? "Edition"
  const tier = s(detail, "tier")
  const thumb = s(detail, "thumbnail_url")
  // ~46% of TS editions have a null thumbnail; the OG route always renders a
  // branded 1200×630, so use it (then a static default) as the image fallback
  // so every Product carries a non-empty absolute image URL.
  const ogImage = slug ? `${BASE_URL}/api/og/edition?collection=${collectionUrlSlug}&slug=${encodeURIComponent(slug)}` : null
  const product: LdValue = {
    "@type": "Product",
    "@id": url,
    url,
    name: `${playerName} — ${setName ?? label}`,
    brand: { "@type": "Brand", name: label },
    image: thumb || ogImage || `${BASE_URL}/api/og/default`,
    description: `${playerName}${setName ? " — " + setName : ""}${tier ? " (" + tier + ")" : ""} on ${label}. Live FMV, recent sales, price history, and the packs that contained this edition.`,
  }
  // Google caps sku length (~50 chars); TS integer pairs ("8:133") keep their
  // sku, AllDay/UFC long descriptive slugs simply omit the optional field.
  if (slug && slug.length <= 40) product.sku = slug
  if (tier) product.category = tier
  // Price from FMV when present, else the live low ask, so structural NO_DATA
  // editions still emit a valid Offer. No fake review/aggregateRating.
  // A STALE FMV is unreliable — skip it as a price source so we don't index a
  // wrong price; a live low ask is still a real, reliable price even on STALE.
  const fmvUsable = fmvConfidence !== "STALE" && fmv !== null && Number.isFinite(fmv) && fmv > 0
  const priceUsd =
    fmvUsable
      ? fmv
      : lowAsk != null && Number.isFinite(lowAsk) && lowAsk > 0
        ? lowAsk
        : null
  if (priceUsd !== null) {
    product.offers = {
      "@type": "Offer",
      price: Math.round(priceUsd * 100) / 100,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url,
    }
  }
  return {
    "@context": "https://schema.org",
    "@graph": [
      product,
      breadcrumbJsonLd([
        { name: "Home", url: BASE_URL },
        { name: label, url: `${BASE_URL}/${collectionUrlSlug}` },
        ...(setSlug && setName ? [{ name: setName, url: `${BASE_URL}/${collectionUrlSlug}/set/${encodeURIComponent(setSlug)}` }] : []),
        { name: playerName, url },
      ]),
    ],
  }
}

// Player → Person (+ BreadcrumbList).
export function playerJsonLd(detail: Payload, collectionUrlSlug: string, slug: string): LdValue {
  const label = COLLECTION_DISPLAY_NAMES[collectionUrlSlug] ?? "Flow"
  const url = `${BASE_URL}/${collectionUrlSlug}/player/${encodeURIComponent(slug)}`
  const name = s(detail, "name") ?? "Player"
  const headshot = s(detail, "headshot_url")
  const team = s(detail, "team")
  const person: LdValue = { "@type": "Person", "@id": url, url, name }
  if (headshot) person.image = headshot
  if (team) person.affiliation = { "@type": "SportsTeam", name: team }
  return {
    "@context": "https://schema.org",
    "@graph": [
      person,
      breadcrumbJsonLd([
        { name: "Home", url: BASE_URL },
        { name: label, url: `${BASE_URL}/${collectionUrlSlug}` },
        { name, url },
      ]),
    ],
  }
}

// Team → SportsTeam / Organization (+ BreadcrumbList).
export function teamJsonLd(detail: Payload, collectionUrlSlug: string, slug: string): LdValue {
  const label = COLLECTION_DISPLAY_NAMES[collectionUrlSlug] ?? "Flow"
  const url = `${BASE_URL}/${collectionUrlSlug}/team/${encodeURIComponent(slug)}`
  const name = s(detail, "team_name") ?? "Team"
  const isFranchise = detail["is_franchise"] === true
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": isFranchise ? "Organization" : "SportsTeam", "@id": url, url, name },
      breadcrumbJsonLd([
        { name: "Home", url: BASE_URL },
        { name: label, url: `${BASE_URL}/${collectionUrlSlug}` },
        { name, url },
      ]),
    ],
  }
}

// Set / Series → CollectionPage + ItemList (+ BreadcrumbList). eds = the
// EditionTile[] the page already fetched; capped at 25.
export function collectionEntityJsonLd(opts: {
  name: string
  url: string
  collectionUrlSlug: string
  eds: Array<Payload>
  crumbName: string
}): LdValue {
  const label = COLLECTION_DISPLAY_NAMES[opts.collectionUrlSlug] ?? "Flow"
  const items = (opts.eds ?? []).slice(0, 25).map((e, i) => {
    const li: LdValue = {
      "@type": "ListItem",
      position: i + 1,
      url: `${BASE_URL}/${opts.collectionUrlSlug}/edition/${encodeURIComponent(s(e, "route_slug") ?? "")}`,
    }
    const nm = s(e, "player_name") ?? s(e, "name")
    const img = s(e, "thumbnail_url")
    if (nm) li.name = nm
    if (img) li.image = img
    return li
  })
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        "@id": opts.url,
        url: opts.url,
        name: opts.name,
        isPartOf: { "@type": "WebSite", name: "Rip Packs City", url: BASE_URL },
        mainEntity: { "@type": "ItemList", numberOfItems: items.length, itemListElement: items },
      },
      breadcrumbJsonLd([
        { name: "Home", url: BASE_URL },
        { name: label, url: `${BASE_URL}/${opts.collectionUrlSlug}` },
        { name: opts.crumbName, url: opts.url },
      ]),
    ],
  }
}

// Pack distribution → Product (+ BreadcrumbList).
export function packJsonLd(opts: {
  title: string
  image?: string | null
  collectionUrlSlug: string
  distId: string
  retailPriceUsd?: number | null
}): LdValue {
  const label = COLLECTION_DISPLAY_NAMES[opts.collectionUrlSlug] ?? "Flow"
  const url = `${BASE_URL}/${opts.collectionUrlSlug}/pack/dist/${encodeURIComponent(opts.distId)}`
  // Same image+description gap as editionJsonLd — OG pack route is the fallback.
  const ogImage = opts.distId
    ? `${BASE_URL}/api/og/pack?collection=${opts.collectionUrlSlug}&distId=${encodeURIComponent(opts.distId)}`
    : null
  const product: LdValue = {
    "@type": "Product",
    "@id": url,
    url,
    name: opts.title,
    brand: { "@type": "Brand", name: label },
    image: opts.image || ogImage || `${BASE_URL}/api/og/default`,
    description: `${opts.title} on ${label}. Pack EV, pull odds, grail chances, and the editions inside this pack.`,
  }
  if (opts.retailPriceUsd && opts.retailPriceUsd > 0) {
    product.offers = { "@type": "Offer", price: Math.round(opts.retailPriceUsd * 100) / 100, priceCurrency: "USD", url }
  }
  return {
    "@context": "https://schema.org",
    "@graph": [
      product,
      breadcrumbJsonLd([
        { name: "Home", url: BASE_URL },
        { name: label, url: `${BASE_URL}/${opts.collectionUrlSlug}` },
        { name: opts.title, url },
      ]),
    ],
  }
}

// Absolute entity URLs — handy for the page-side JSON-LD `url`/breadcrumb args
// (the helpers above build child URLs themselves, but the CollectionPage
// helpers need the page's own absolute url).
export function entityUrl(collectionUrlSlug: string, kind: string, slug: string): string {
  return `${BASE_URL}/${collectionUrlSlug}/${kind}/${encodeURIComponent(slug)}`
}
