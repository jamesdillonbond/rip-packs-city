import type { Metadata } from 'next'
import { proxyIpfsUrlAbsolute } from './ipfs-media'
import { metaField } from './format'
import { isMarketClosed, closedMarket, formatClosedOn } from "@/lib/market-closed"
import { collectionHasPage, type CollectionPage } from "@/lib/collections"

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.rippackscity.com'

// Root layout metadata — import into app/layout.tsx as: export const metadata = rootMetadata
// Home (/) inherits these directly \u2014 the marketing page does not export its
// own metadata, so default title, description, openGraph, and twitter all
// describe the home surface. The %s template below still applies per-subpage.
const ROOT_TITLE =
  'Rip Packs City \u2014 The Intelligence Layer for Flow Collectibles'
const ROOT_DESCRIPTION =
  'Real-time FMV, deal sniping, wallet analytics, badge tracking, pack tools, and set intelligence for NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga Golazos, and UFC Strike collectors on Flow blockchain.'

// The one place the brand suffix is spelled. Any segment that sets a plain
// string `title` is formatted by the NEAREST ANCESTOR template and provides no
// template of its own, so an intermediate layout with a string title silently
// strips the suffix from everything below it. That is deep-audit R31: ~70
// indexable deep URLs rendered with no brand at all while /insights and / — both
// one level down — rendered correctly, which is why it read as fine.
export const BRAND_TITLE_TEMPLATE = '%s | Rip Packs City'

export const rootMetadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: ROOT_TITLE,
    template: BRAND_TITLE_TEMPLATE,
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
    images: [
      {
        url: '/api/og/default',
        width: 1200,
        height: 630,
        alt: 'Rip Packs City — Flow collectibles intelligence',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    // `site` attributes the CARD to the account; `creator` attributes the
    // CONTENT. X shows the site handle in the card byline, and it was missing
    // at the root — so every page that does not define its own twitter block
    // (the majority) unfurled with no attribution at all.
    site: '@RipPacksCity',
    creator: '@RipPacksCity',
    title: ROOT_TITLE,
    description: ROOT_DESCRIPTION,
    images: [{ url: '/api/og/default', alt: 'Rip Packs City — Flow collectibles intelligence' }],
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
    '@type': 'Organization',
    name: 'Rip Packs City',
    url: BASE_URL,
  },
}

type PageMeta = { title: string; description: string }

// Generic per-page templates — {label} is replaced by the collection's display name.
// Descriptions stay cross-collection-friendly: any Flow blockchain wallet across
// Top Shot, All Day, Pinnacle, Golazos, and UFC funnels through these helpers.
const PAGE_META: Record<string, PageMeta> = {
  overview: {
    title: '{label} Value — FMV, Floor Prices & Market Pulse',
    description:
      'What {label} moments are worth: live FMV, floor prices, top sales, and the daily market pulse on Flow — for any moment or your whole account.',
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
  play: {
    title: 'Play — {label} Challenges, Fast Break & Road to the Ring',
    description:
      'Game tools for {label}: Set & Crafting Challenges ranked by net EV, Fast Break lineup optimization, and Road to the Ring ROI tracking on Flow blockchain.',
  },
}

// Per-collection overrides keyed by `${page}:${collectionId}`.
// The per-collection feature tabs that have their OWN SEO copy in PAGE_META and
// therefore SELF-CANONICALISE via pageMetadata(). Exported so lib/sitemap-data.ts
// can DERIVE which tabs are worth advertising instead of hardcoding a list.
//
// ⚠ Membership here is the indexability test, and that is not incidental. A tab
// with no PAGE_META entry (pack-sniper / challenges / hot-floors) never calls
// pageMetadata, so it inherits collectionLayoutMetadata and emits a
// `<link rel="canonical">` pointing at the collection ROOT, not at itself —
// verified live 2026-08-20 on /nba-top-shot/challenges. Listing a
// self-canonicalising-away URL in a sitemap asks Google to index a declared
// duplicate, so those tabs are excluded BY DERIVATION rather than by a second
// list that could drift.
export const PUBLIC_TAB_PAGES: string[] = Object.keys(PAGE_META)

const PAGE_META_OVERRIDES: Record<string, PageMeta> = {}

// ── The openGraph / twitter shallow-merge trap (deep-audit R10) ─────────────
// Next merges page metadata into the root export at the TOP-LEVEL key only.
// Defining `openGraph` (or `twitter`) in a child REPLACES the root's block
// outright rather than merging into it — so every field the child omits is
// simply gone from the rendered tags. The root defines siteName / type / locale
// and the twitter site+creator handles, and all three shared helpers below were
// dropping some of them across ~40 tab URLs, the whole entity corpus (~23.5k
// editions) and the 5 collection roots. The visible symptom: the public boards
// the concierge calls "the most shareable thing RPC has" unfurled with NO X
// byline at all.
//
// `app/profile/[username]/layout.tsx` documents the same trap and gets it right;
// the fix was never generalised to here. Spread these into every block rather
// than restating the literals, so a future field added at the root only has to
// be added in one more place.
//
// ⚠ EXPORTED (2026-08-17). The instruction three lines up — "spread these into
// every block rather than restating the literals" — had only ever been applied
// to the three helpers below. 43 `app/**` files build their metadata inline and
// so bypassed them entirely; 31 of those were the /insights board layouts, which
// set `creator` and omitted `site`, dropping the very byline this block was
// added to restore. They now spread these, and
// __tests__/metadata-inline-blocks-inherit-root-fields.test.ts walks the tree
// rather than naming the helpers, so a new inline block cannot reopen it.
export const OG_INHERITED = { type: 'website', locale: 'en_US', siteName: 'Rip Packs City' } as const
export const TWITTER_INHERITED = { card: 'summary_large_image', site: '@RipPacksCity', creator: '@RipPacksCity' } as const

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
      ...OG_INHERITED,
      title: `${title} | Rip Packs City`,
      description,
      url: canonical,
    },
    twitter: {
      ...TWITTER_INHERITED,
      title,
      description,
    },
  }
}

// The `[collection]` route segment is unvalidated user input, and every
// `[collection]/*/layout.tsx` falls back to generic "Flow" metadata when it does
// not resolve to a registry entry. `pageMetadata` builds `canonical` from that
// raw segment, so the fallback used to emit a SELF-canonical page that inherited
// the root `index, follow` — an unbounded set of indexable URLs each claiming to
// be the canonical copy of one page.
//
// Measured live 2026-08-15: `/totally-bogus-slug/overview` returned 200 with
// `canonical=/totally-bogus-slug/overview` and `robots=index, follow`, rendering
// the same Top Shot page as `/topshot/overview` and `/nba-top-shot/overview`.
// Only `/overview` is anonymously reachable with an arbitrary segment — the proxy
// opens /^\/[^/]+\/overview$/ for ANY segment, while the other tabs are opened only
// for the 5 published slugs. The other seven layouts are gated today and share
// this helper anyway, so the hole does not reopen the next time a tab is
// un-gated, which is exactly how /overview became reachable (2026-07-17 launch).
//
// noindex rather than a canonical pointing at the real page: the SERVER cannot
// tell which collection was meant (resolution fails here; the CLIENT falls back
// to the last-visited collection), so naming one would be a guess published as a
// directive. `follow` stays true — the links out are real pages.
//
// This is the honest floor, not the end state: a slug people actually link to
// (e.g. `topshot`) should 301 to /nba-top-shot/..., a routing decision not a
// metadata one.
// ── Folded-tab canonical targets (2026-08-21) ──────────────────────────────
//
// `pack-sniper`, `challenges` and `hot-floors` are the 2026-07-18 IA reorg's
// FOLDED pages: filtered out of the tab bar by `tabBarPages()` and, unlike
// their seven siblings, given no `PAGE_META` entry and no layout. So they
// inherited `collectionLayoutMetadata()` and emitted
// `canonical=/<collection>` — pointing at the collection ROOT.
//
// ⚠ AND THAT ROOT IS AUTH-GATED. Verified live 2026-08-20: `GET /nba-top-shot`
// returns `x-matched-path: /login`, and `isPublicPath('/nba-top-shot','GET')` is
// false for all five. Four anon-public URLs were telling Google *"the canonical
// version of me is a page you will be redirected away from."*
//
// The consolidation INTENT was right — these are sub-surfaces, and promoting
// them to self-canonical would put them in query competition with their own
// parents (`PAGE_META.play` already claims "Challenges"). Only the TARGET was
// wrong. So each folded tab canonicalises to the public parent it was folded
// into, grounded in the repo's own one-line pitches in lib/collections.ts
// rather than in a guess:
//
//   challenges  -> play    "Challenges, Fast Break, and Road to the Ring"
//                          (the ONLY mapping also confirmed by a real link:
//                           components/play/PlayHub.tsx links /<id>/challenges)
//   pack-sniper -> packs   "Sealed packs listed below their expected pull
//                          value" vs "Pack EV calculator — find drops where
//                          EV > retail"
//   hot-floors  -> market  "Editions whose floor is being actively swept" vs
//                          "Sort and filter every indexed listing"
//
// ⚠ `pack-sniper` and `hot-floors` have ZERO inbound links anywhere in the app
// (measured 2026-08-21 — only `challenges` is linked, from PlayHub). They are
// reachable by direct URL only, so their mapping rests on the pitches above,
// not on observed navigation. Recorded so the next reader knows which of the
// three is evidence and which two are reasoned.
export const FOLDED_TAB_PARENT: Record<string, string> = {
  'pack-sniper': 'packs',
  challenges: 'play',
  'hot-floors': 'market',
}

// Canonical URL for a folded tab. ⚠ Falls back to `/overview` when the
// collection does not expose the parent — without this, `/ufc/challenges`
// would canonicalise to `/ufc/play`, and UFC ships no `play` tab either, so
// the fix would just move the broken target. `/overview` is the one tab every
// published collection exposes, and it is anon-public, self-canonical and
// sitemapped.
export function foldedTabCanonical(page: string, collectionId: string): string {
  const parent = ownMeta(FOLDED_TAB_PARENT, page)
  const target = parent && collectionHasPage(collectionId, parent as CollectionPage) ? parent : 'overview'
  return `${BASE_URL}/${collectionId}/${target}`
}

export function unknownCollectionMetadata(page: string, id: string): Metadata {
  return { ...pageMetadata(page, "Flow", id), robots: { index: false, follow: true } }
}

// Own-property guard for the collection lookup maps below. All are keyed by the
// route's `[collection]` segment (collectionId / collectionUrlSlug), which is
// unvalidated user input — a bare `MAP[key]` read matches inherited
// Object.prototype members, so a crafted slug like "constructor" / "toString"
// would return a prototype member (a truthy function) instead of taking the
// `?? "Flow"` fallback, surfacing a function in a <title> / meta / JSON-LD.
function ownMeta<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
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
  const meta = ownMeta(COLLECTION_LAYOUT_META, collectionId) ?? {
    title: 'Rip Packs City — Collector Intelligence',
    description:
      'The smartest analytics platform for NBA Top Shot and NFL All Day collectors. FMV pricing, set intelligence, pack EV, and a live marketplace sniper.',
  }
  const canonical = `${BASE_URL}/${collectionId}`
  const label = ownMeta(COLLECTION_LABELS, collectionId) ?? 'Flow'
  // Per-collection OG image. /api/og/collection?id=<slug> renders a
  // 1200×630 card branded with the collection's icon, label, accent
  // color, and chain pill. Returns the generic fallback for unknown ids.
  const ogImage = `${BASE_URL}/api/og/collection?id=${collectionId}`
  return {
    // ⚠ BOTH HALVES ARE LOAD-BEARING and they fix two OPPOSITE live defects.
    //
    // `absolute` — these entries already end in " — Rip Packs City" (they are
    // reused verbatim for OG/Twitter below), and a plain string here is fed to
    // the ROOT template, so /nba-top-shot rendered
    // "NBA Top Shot Analytics — Rip Packs City | Rip Packs City" live. That is
    // the D24 double-suffix class the app/-only guard could not see: it walks
    // app/, this file is lib/, and it matched only the pipe form.
    //
    // `template` — a string title here would ALSO leave every descendant with
    // no template at all, which is why /nba-top-shot/collection rendered
    // "Wallet Analytics — Track Your NBA Top Shot Collection Value" with no
    // brand (R31). Re-declaring it puts the suffix back for the whole subtree.
    title: { absolute: meta.title, template: BRAND_TITLE_TEMPLATE },
    description: meta.description,
    alternates: { canonical },
    keywords: [label, 'FMV', 'moment value', 'collector tools', 'sniper deals', 'Flow blockchain'],
    openGraph: {
      ...OG_INHERITED,
      title: meta.title,
      description: meta.description,
      url: canonical,
      images: [{ url: ogImage, width: 1200, height: 630, alt: label }],
    },
    twitter: {
      ...TWITTER_INHERITED,
      title: meta.title,
      description: meta.description,
      images: [ogImage],
    },
  }
}

// JSON-LD CollectionPage schema for /[collection]/* pages. Includes a
// minimal BreadcrumbList so Google can render the path-trail rich result.
export function collectionPageJsonLd(collectionId: string): object {
  const label = ownMeta(COLLECTION_LABELS, collectionId) ?? collectionId
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
          ownMeta(COLLECTION_LAYOUT_META, collectionId)?.description ??
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
  const label = ownMeta(COLLECTION_LABELS, collectionId) ?? 'Flow'
  return pageMetadata(page, label, collectionId)
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

// UFC has a legacy URL alias "ufc-strike" that getCollectionByUrlSlug still
// accepts, so /ufc-strike/... entity + tab pages RENDER (the page body doesn't
// 404 the alias). Without an alias key every label map above fell through to
// "Flow" — so a real UFC page reached via the alias showed "Flow" as its brand
// in the title, OG, breadcrumbs, and JSON-LD. Mirror the canonical "ufc" entry
// onto the alias in all three maps rather than duplicating the values.
// (In-app links emit the canonical "ufc" as of 2026-08-02, so this only covers
// legacy/external inbound links; the alias URL still self-canonicalizes — a
// 301 alias→canonical redirect is the separate, larger follow-up.)
COLLECTION_LABELS["ufc-strike"] = COLLECTION_LABELS["ufc"]
COLLECTION_DISPLAY_NAMES["ufc-strike"] = COLLECTION_DISPLAY_NAMES["ufc"]

// " (last values before the Flow market closed 13 May 2026)" — appended to any
// aggregate FMV we publish for a collection whose market has shut down, so a
// rollup total is never read as a current valuation. Empty string on live
// markets, so it is safe to interpolate unconditionally.
function fmvClosedQualifier(collectionUrlSlug: string): string {
  const cm = closedMarket(collectionUrlSlug)
  if (!cm) return ""
  return ` (last values before the ${cm.venue} market closed ${formatClosedOn(cm.closedOn)})`
}
COLLECTION_LAYOUT_META["ufc-strike"] = COLLECTION_LAYOUT_META["ufc"]

// Every description builder below joins these reads with a separator (", ",
// " — ", " · ", " | "), so one untrimmed catalog value leaks into `description`,
// `og:description` and `twitter:description` at once. Trim at the read boundary
// (2026-07-25) — a whitespace-only value counts as ABSENT so the callers'
// `?? "Set"` / `?? "Edition"` fallbacks fire instead of emitting "  on NBA Top
// Shot." See lib/format.ts `metaField` for the same rule and the live example.
function s(p: Payload, k: string): string | null {
  return metaField(p[k])
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
    // Entity titles are fully formed and already carry "| Rip Packs City" (see
    // the four builders below). `absolute` so restoring the subtree template in
    // collectionLayoutMetadata does not double-suffix the ~33k-URL entity corpus.
    title: { absolute: opts.title },
    description: opts.description,
    alternates: { canonical: opts.canonical },
    openGraph: {
      ...OG_INHERITED,
      title: opts.title,
      description: opts.description,
      url: opts.canonical,
      images: [{ url: image, width: 1200, height: 630 }],
    },
    twitter: {
      ...TWITTER_INHERITED,
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
  const collectionLabel = ownMeta(COLLECTION_DISPLAY_NAMES, collectionUrlSlug) ?? "Flow"
  const routeSlug = s(payload, "route_slug") ?? s(payload, "external_id") ?? ""
  // Team moments have no player_name — fall back to the team before the raw
  // edition name so the title isn't blank/generic. Item 3 (2026-06-11).
  const playerName = s(payload, "player_name") ?? s(payload, "team_name") ?? s(payload, "name") ?? "Edition"
  const setName = s(payload, "set_name") ?? "Edition"
  const tier = s(payload, "tier")
  const seriesLabel = s(payload, "series_label")
  const circulation = n(payload, "circulation_count")
  const thumbnail = s(payload, "thumbnail_url")
  const fmvObj = (payload.fmv as Payload | null | undefined) ?? null
  const fmvUsd = fmvObj ? n(fmvObj, "fmv_usd") : null
  const subject = playerName
  const context = setName
  // On a closed market the FMV is the last value observed before trading stopped, so
  // the title must not present it as a current valuation. See lib/market-closed.ts.
  const cm = closedMarket(collectionUrlSlug)
  const title = cm
    ? `${subject} — ${fmvUsd ? `${context} · Last Value ${fmtUsd(fmvUsd)}` : `${context} · Value History & Sales`} (${cm.venue} market closed) | ${collectionLabel} | Rip Packs City`
    : `${subject} — ${fmvUsd ? `${context} · Value ${fmtUsd(fmvUsd)}` : `${context} · Value, Floor & Sales`} | ${collectionLabel} | Rip Packs City`
  const descParts = [
    cm
      ? (fmvUsd
          ? `${subject} ${setName} last traded around ${fmtUsd(fmvUsd)} on ${collectionLabel} before its ${cm.venue} market closed on ${formatClosedOn(cm.closedOn)}. Historical value, not a current price.`
          : `${subject} ${setName} on ${collectionLabel} — historical value and sales. The ${cm.venue} market closed on ${formatClosedOn(cm.closedOn)}.`)
      : (fmvUsd
          ? `${subject} ${setName} is worth ~${fmtUsd(fmvUsd)} (FMV) on ${collectionLabel}.`
          : `${subject} ${setName} on ${collectionLabel} — live fair-market value, floor, and recent sales.`),
    tier ? `Tier ${tier}.` : null,
    seriesLabel ? `${formatSeriesLabel(seriesLabel, collectionUrlSlug)}.` : null,
    circulation ? `Circulation ${fmtCount(circulation)}.` : null,
    null,
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
  const collectionLabel = ownMeta(COLLECTION_DISPLAY_NAMES, collectionUrlSlug) ?? "Flow"
  const setName = s(payload, "set_name") ?? "Set"
  const editionCount = n(payload, "edition_count")
  const totalCirc = n(payload, "total_circulation")
  const fmvTotal = n(payload, "fmv_total_usd")
  const title = `${setName} — Set Value & Editions | ${collectionLabel} | Rip Packs City`
  const descParts = [
    `${setName} on ${collectionLabel}.`,
    editionCount ? `${fmtCount(editionCount)} editions.` : null,
    totalCirc ? `${fmtCount(totalCirc)} total circulation.` : null,
    fmvTotal ? `Aggregate FMV ${fmtUsd(fmvTotal)}${fmvClosedQualifier(collectionUrlSlug)}.` : null,
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
  const collectionLabel = ownMeta(COLLECTION_DISPLAY_NAMES, collectionUrlSlug) ?? "Flow"
  const isCharacter = payload["is_character"] === true
  const noun = isCharacter ? "Character" : "Player"
  const name = s(payload, "name") ?? "Player"
  const team = s(payload, "team")
  const editionCount = n(payload, "edition_count")
  const fmvTotal = n(payload, "fmv_total_usd")
  const headshot = s(payload, "headshot_url")
  const teamLabel = isCharacter ? "Franchise" : "Team"
  const title = `${name} — Moments & Market Value | ${collectionLabel} | Rip Packs City`
  const descParts = [
    `${name} (${noun}) on ${collectionLabel}.`,
    team ? `${teamLabel}: ${team}.` : null,
    editionCount ? `${fmtCount(editionCount)} editions.` : null,
    fmvTotal ? `Portfolio FMV ${fmtUsd(fmvTotal)}${fmvClosedQualifier(collectionUrlSlug)}.` : null,
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
  const collectionLabel = ownMeta(COLLECTION_DISPLAY_NAMES, collectionUrlSlug) ?? "Flow"
  const isFranchise = payload["is_franchise"] === true
  const noun = isFranchise ? "Franchise" : "Team"
  const teamName = s(payload, "team_name") ?? "Team"
  const playerCount = n(payload, "player_count")
  const editionCount = n(payload, "edition_count")
  const fmvTotal = n(payload, "fmv_total_usd")
  const title = `${teamName} — Moments & Market Value | ${collectionLabel} | Rip Packs City`
  const descParts = [
    `${teamName} ${noun.toLowerCase()} on ${collectionLabel}.`,
    playerCount ? `${fmtCount(playerCount)} ${isFranchise ? "characters" : "players"}.` : null,
    editionCount ? `${fmtCount(editionCount)} editions.` : null,
    fmvTotal ? `Aggregate FMV ${fmtUsd(fmvTotal)}${fmvClosedQualifier(collectionUrlSlug)}.` : null,
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
  const collectionLabel = ownMeta(COLLECTION_DISPLAY_NAMES, collectionUrlSlug) ?? "Flow"
  const displayLabel = s(payload, "display_label") ?? "Series"
  const season = s(payload, "season")
  const editionCount = n(payload, "edition_count")
  const setCount = n(payload, "set_count")
  const playerCount = n(payload, "player_count")
  const fmvTotal = n(payload, "fmv_total_usd")
  const subject = displayLabel
  const title = `${subject}${season ? ` (Season ${season})` : ""} — ${collectionLabel} Editions & Values | Rip Packs City`
  const descParts = [
    `${displayLabel} on ${collectionLabel}.`,
    season ? `Season ${season}.` : null,
    editionCount ? `${fmtCount(editionCount)} editions.` : null,
    setCount ? `${fmtCount(setCount)} sets.` : null,
    playerCount ? `${fmtCount(playerCount)} players.` : null,
    fmvTotal ? `Aggregate FMV ${fmtUsd(fmvTotal)}${fmvClosedQualifier(collectionUrlSlug)}.` : null,
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
  return ownMeta(COLLECTION_DISPLAY_NAMES, collectionUrlSlug) ?? "Flow"
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
  const label = ownMeta(COLLECTION_DISPLAY_NAMES, collectionUrlSlug) ?? "Flow"
  const slug = s(detail, "route_slug") ?? s(detail, "external_id") ?? ""
  const url = `${BASE_URL}/${collectionUrlSlug}/edition/${encodeURIComponent(slug)}`
  const fmvObj = (detail.fmv as Payload | null | undefined) ?? null
  const fmv = fmvObj ? n(fmvObj, "fmv_usd") : null
  const fmvConfidence = fmvObj ? s(fmvObj, "confidence") : null
  const setName = s(detail, "set_name")
  const setSlug = s(detail, "set_slug")
  const playerName = s(detail, "player_name") ?? s(detail, "team_name") ?? s(detail, "name") ?? "Edition"
  const tier = s(detail, "tier")
  // Route slow ipfs.io CIDs (UFC + legacy art) through the edge-cached proxy so
  // Google's rich-result image fetch is reliable; typed CDN URLs pass through.
  const thumb = proxyIpfsUrlAbsolute(s(detail, "thumbnail_url"), BASE_URL)
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
    description: `${playerName}${setName ? " — " + setName : ""}${tier ? " (" + tier + ")" : ""} on ${label}. ${
      isMarketClosed(collectionUrlSlug)
        ? `Historical value and sales history — the ${closedMarket(collectionUrlSlug)!.venue} market for this collection closed on ${formatClosedOn(closedMarket(collectionUrlSlug)!.closedOn)}.`
        : "Live FMV, recent sales, price history, and the packs that contained this edition."
    }`,
  }
  // Google caps sku length (~50 chars); TS integer pairs ("8:133") keep their
  // sku, AllDay/UFC long descriptive slugs simply omit the optional field.
  if (slug && slug.length <= 40) product.sku = slug
  if (tier) product.category = tier
  // Price from FMV when present, else the live low ask, so structural NO_DATA
  // editions still emit a valid Offer. No fake review/aggregateRating.
  // A STALE FMV is unreliable — skip it as a price source so we don't index a
  // wrong price; a live low ask is still a real, reliable price even on STALE.
  // A CLOSED market emits NO Offer at all. This is deliberately stronger than the
  // STALE guard below: when a marketplace shuts down the FMV pipeline keeps
  // re-stamping computed_at, so a dead price can carry a MEDIUM/HIGH confidence and
  // a fresh timestamp and sail straight through a confidence check (measured for
  // UFC 2026-08-02: 15 editions re-stamped today off sales 470+ days old). A
  // schema.org Offer asserts availability and a transactable price to Google; on a
  // closed market both claims are false, and a residual low ask is not executable
  // either, so neither price source may be published. See lib/market-closed.ts.
  const marketClosed = isMarketClosed(collectionUrlSlug)
  const fmvUsable = fmvConfidence !== "STALE" && fmv !== null && Number.isFinite(fmv) && fmv > 0
  const priceUsd = marketClosed
    ? null
    : fmvUsable
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
  const label = ownMeta(COLLECTION_DISPLAY_NAMES, collectionUrlSlug) ?? "Flow"
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
  const label = ownMeta(COLLECTION_DISPLAY_NAMES, collectionUrlSlug) ?? "Flow"
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
  const label = ownMeta(COLLECTION_DISPLAY_NAMES, opts.collectionUrlSlug) ?? "Flow"
  const items = (opts.eds ?? []).slice(0, 25).map((e, i) => {
    const li: LdValue = {
      "@type": "ListItem",
      position: i + 1,
      url: `${BASE_URL}/${opts.collectionUrlSlug}/edition/${encodeURIComponent(s(e, "route_slug") ?? "")}`,
    }
    const nm = s(e, "player_name") ?? s(e, "name")
    const img = proxyIpfsUrlAbsolute(s(e, "thumbnail_url"), BASE_URL)
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
  const label = ownMeta(COLLECTION_DISPLAY_NAMES, opts.collectionUrlSlug) ?? "Flow"
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

// Soft-404 hardening (2026-07-11): entity pages under a loading.tsx boundary
// stream, so notFound() can no longer change the HTTP status (stays 200).
// generateMetadata DOES run before streaming — returning this instead of {}
// keeps invalid entities (exhibition teams, UUID fossils, unknown slugs) out
// of the index and kills the doubled-suffix-title / wrong-canonical fallback.
export const NOT_FOUND_METADATA: Metadata = {
  title: "Not Found",
  robots: { index: false, follow: false },
}
