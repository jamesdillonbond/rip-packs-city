import { editionRouteHref } from "@/lib/entity-href"
import type { Metadata } from 'next'
import { proxyIpfsUrlAbsolute } from './ipfs-media'
import { metaField } from './format'
import { isMarketClosed, closedMarket, formatClosedOn } from "@/lib/market-closed"
import { COLLECTIONS, collectionHasPage, getCollection, type CollectionPage } from "@/lib/collections"
import { ASK_STALE_HOURS } from "@/lib/market/ask-freshness"
import { MAX_ASK_AGE_HOURS_CORROBORATION } from "@/lib/fmv-confidence"
import { editionTitleContext } from "@/lib/edition-title-context"
import { editionDescriptionSnippet } from "@/lib/edition/description"
import { productOrCreativeWork } from "@/lib/jsonld-product"
import { getInsightsBoard, type InsightsBoard } from "@/lib/insights/board-registry"

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.rippackscity.com'

// Root layout metadata — import into app/layout.tsx as: export const metadata = rootMetadata
// Home (/) inherits these directly \u2014 the marketing page does not export its
// own metadata, so default title, description, openGraph, and twitter all
// describe the home surface. The %s template below still applies per-subpage.
// Chain-neutral since 2026-10-17: the "Flow-only until chain two ships" tagline
// rule (chain-strategy.md) had met its condition — Candy MLB (Solana) has been
// live since 09-06 — so a site-wide "for Flow Collectibles" was a small false claim.
const ROOT_TITLE =
  'Rip Packs City \u2014 The Intelligence Layer for Digital Collectibles'
const CHAIN_NAMES: Record<string, string> = { flow: 'Flow', solana: 'Solana' }

/**
 * "NBA Top Shot, … and UFC Strike on Flow, Candy MLB on Solana, and Panini
 * Blockchain" — every PUBLISHED collection, grouped by its registry `dbChain`.
 *
 * DERIVED, never hand-listed (2026-10-14). The hand-written root description
 * and root JSON-LD stopped at UFC and said "on Flow blockchain", so every page
 * on the site described a Solana collection and Panini as absent, and the
 * whole catalogue as Flow. A collection with no established chain (Panini,
 * dbChain null) is named with no chain claim — see chain-strategy.md.
 */
export function publishedCollectionsPhrase(): string {
  const groups: Array<{ chain: string | null; labels: string[] }> = []
  for (const c of COLLECTIONS.filter((x) => x.published)) {
    const chain = c.dbChain && CHAIN_NAMES[c.dbChain] ? CHAIN_NAMES[c.dbChain] : null
    const g = groups.find((x) => x.chain === chain && chain !== null)
    if (g) g.labels.push(c.label)
    else groups.push({ chain, labels: [c.label] })
  }
  // Chained groups first (Flow is the incumbent), unchained labels last.
  groups.sort((a, b) => Number(a.chain === null) - Number(b.chain === null))
  const parts = groups.map((g) => {
    const names =
      g.labels.length > 1 ? `${g.labels.slice(0, -1).join(', ')} and ${g.labels[g.labels.length - 1]}` : g.labels[0]
    return g.chain ? `${names} on ${g.chain}` : names
  })
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}` : parts[0]
}

const ROOT_DESCRIPTION = `Real-time FMV, deal sniping, wallet analytics, badge tracking, pack tools, and set intelligence for collectors of ${publishedCollectionsPhrase()}.`

// The one place the brand suffix is spelled. Any segment that sets a plain
// string `title` is formatted by the NEAREST ANCESTOR template and provides no
// template of its own, so an intermediate layout with a string title silently
// strips the suffix from everything below it. That is deep-audit R31: ~70
// indexable deep URLs rendered with no brand at all while /insights and / — both
// one level down — rendered correctly, which is why it read as fine.
export const BRAND_TITLE_TEMPLATE = '%s | Rip Packs City'

// The CONTENT half of the root openGraph block, shared with the home page.
//
// ⚠ WHY THIS IS SHARED RATHER THAN RESTATED. Home ("/") is the one surface that
// must define its own `openGraph`, because it is the only page whose `og:url`
// cannot come from a route-specific builder — and Next merges `openGraph` at the
// TOP-LEVEL KEY ONLY, so defining it there REPLACES this block outright. Copying
// title/description/images across would make the homepage's unfurl drift from the
// root's the first time either is edited; sharing the object makes that
// impossible, so a field added here reaches home for free.
//
// The three INHERITED fields (type/locale/siteName) are deliberately NOT in here
// — see the note in the openGraph block below, and OG_INHERITED further down.
export const ROOT_OG_CONTENT = {
  title: ROOT_TITLE,
  description: ROOT_DESCRIPTION,
  images: [
    {
      url: '/api/og/default',
      width: 1200,
      height: 630,
      alt: 'Rip Packs City — digital collectibles intelligence',
    },
  ],
}

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
    // ⚠ type/locale/siteName stay SPELLED OUT here rather than spreading
    // OG_INHERITED: that const is declared far below this one, so referencing it
    // in this initialiser is a temporal-dead-zone ReferenceError at module load.
    // The guard asserts the two agree.
    type: 'website',
    locale: 'en_US',
    siteName: 'Rip Packs City',
    ...ROOT_OG_CONTENT,
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
    images: [{ url: '/api/og/default', alt: 'Rip Packs City — digital collectibles intelligence' }],
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
  description: `Collector intelligence platform for ${publishedCollectionsPhrase()}.`,
  applicationCategory: 'FinanceApplication',
  operatingSystem: 'Web',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  creator: {
    '@type': 'Organization',
    name: 'Rip Packs City',
    url: BASE_URL,
  },
}

// ── The organisation, as an entity ───────────────────────────────────────────
//
// `organizationJsonLd` above is the ROOT node and is a WebApplication; its
// `creator` is a bare {name,url}. Google's Organization guidance wants a
// `logo` and `sameAs` so a brand can be reconciled with its social profile,
// and until 2026-10-11 nothing on the site emitted them (review §3 E1).
// Shared by /about (top-level node), every insights Dataset's `creator`/
// `publisher` and the blog's BlogPosting `author`/`publisher`, so the brand is
// described ONE way everywhere.
export const RPC_ORGANIZATION = {
  '@type': 'Organization',
  name: 'Rip Packs City',
  url: BASE_URL,
  logo: `${BASE_URL}/rip-packs-city-logo.png`,
  sameAs: ['https://x.com/RipPacksCity'],
} as const

/** Top-level Organization node — emitted by app/about/page.tsx. */
export const organizationEntityJsonLd = {
  '@context': 'https://schema.org',
  ...RPC_ORGANIZATION,
}

// ── Public /insights boards → schema.org Dataset ─────────────────────────────
//
// Until 2026-10-11 the 14 Dataset nodes on the estate were all under the
// auth-gated app/(analytics) tree, while the 32 anon-public boards emitted a
// copy-pasted WebApplication + $0 Offer (see lib/insights/board-registry.ts).
// `distribution` names the board's public JSON route ONLY when the registry
// says one exists with no required params; `temporalCoverage` is deliberately
// absent — the boards' windows ("last 60 days", "24h/7d/30d") are rolling and
// schema.org wants an ISO 8601 date or interval, so any value here would be a
// stale claim the day after it shipped.
export function insightsDatasetJsonLd(board: InsightsBoard): Record<string, unknown> {
  const url = `${BASE_URL}/insights/${board.slug}`
  return {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: board.name,
    description: board.description,
    url,
    isAccessibleForFree: true,
    creator: RPC_ORGANIZATION,
    publisher: RPC_ORGANIZATION,
    ...(board.publicApi
      ? {
          distribution: [
            {
              '@type': 'DataDownload',
              encodingFormat: 'application/json',
              contentUrl: `${BASE_URL}/api/public/insights/${board.slug}`,
            },
          ],
        }
      : {}),
  }
}

// A wallet-paste TOOL is software, not data. Free is the truthful price and the
// one place the `$0 Offer` the boards used to copy actually means something.
export function insightsToolJsonLd(board: InsightsBoard): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: board.name,
    description: board.description,
    url: `${BASE_URL}/insights/${board.slug}`,
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'Any',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: RPC_ORGANIZATION,
  }
}

/**
 * The JSON-LD node for an /insights board layout, by slug.
 *
 * ⚠ THROWS on a slug the registry does not know. Every caller passes a string
 * literal that __tests__/insights-layouts-emit-dataset-json-ld.test.ts renders,
 * so a typo fails the suite rather than quietly emitting nothing on a live page.
 */
export function insightsBoardJsonLd(slug: string): Record<string, unknown> {
  const board = getInsightsBoard(slug)
  if (!board) throw new Error(`insightsBoardJsonLd: "${slug}" is not in lib/insights/board-registry.ts`)
  return board.kind === 'tool' ? insightsToolJsonLd(board) : insightsDatasetJsonLd(board)
}

// ── Blog → schema.org BlogPosting ────────────────────────────────────────────
// The two posts set og:type=article but carried no Article schema and no date
// (review §3 E3). Author is the ORGANISATION — the byline on both posts reads
// "By Rip Packs City" and no person is named on the page, so a Person node
// would be a claim the page does not make.
export function articleJsonLd(opts: {
  headline: string
  description: string
  /** ISO 8601 date (YYYY-MM-DD) or datetime. */
  datePublished: string
  dateModified?: string
  /** Absolute canonical URL of the post. */
  url: string
  /** Absolute image URL. */
  image?: string
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: opts.headline,
    description: opts.description,
    datePublished: opts.datePublished,
    dateModified: opts.dateModified ?? opts.datePublished,
    url: opts.url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': opts.url },
    ...(opts.image ? { image: [opts.image] } : {}),
    author: RPC_ORGANIZATION,
    publisher: RPC_ORGANIZATION,
  }
}

type PageMeta = { title: string; description: string }

// Generic per-page templates — {label} is replaced by the collection's display name.
// Descriptions stay cross-collection-friendly: any Flow blockchain wallet across
// Top Shot, All Day, Pinnacle, Golazos, and UFC funnels through these helpers.
const PAGE_META: Record<string, PageMeta> = {
  overview: {
    title: '{label} Value — FMV, Floor Prices & Market Pulse',
    description:
      // 2026-10-14: "…market pulse on Flow" removed — this template also served
      // Candy MLB (Solana) and Panini; the chain lives in each collection's own copy.
      'What {label} moments are worth: live FMV, floor prices, top sales, and the daily market pulse — for any moment or your whole account.',
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
    // 2026-10-14: was "Portfolio Analytics — Wallet Breakdown … acquisition
    // origin, liquid vs locked FMV, portfolio clarity score": none of which the
    // tab renders. Its sections (CollectionAnalyticsClient) are MARKET analytics:
    // marketplace breakdown, volume / average price / daily sales by tier, top
    // sales, hottest editions, top buyers and sellers (30d).
    title: 'Market Analytics — {label} Sales, Volume & Top Buyers',
    description:
      '{label} market analytics: marketplace breakdown, volume, average price and daily sales by tier, top sales, the hottest editions, and the top buyers and sellers of the last 30 days.',
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

// Disney Pinnacle (2026-09-27): the generic templates speak a sports
// collection's vocabulary — "moments", "players", badge detection, "liquid vs
// locked FMV", pull odds — and several list five collections on a page that
// serves one. Pinnacle sells PINS by character, franchise and variant, has no
// badges and no lock UI, and its packs publish no pull odds. Its own copy, so
// a search result or link preview makes no claim the page cannot back.
const PINNACLE_ID = 'disney-pinnacle'
const PANINI_ID = 'panini-blockchain'
const PAGE_META_OVERRIDES: Record<string, PageMeta> = {
  [`overview:${PINNACLE_ID}`]: {
    title: '{label} Value — Pin FMV, Floor Prices & Market Pulse',
    description:
      'What Disney Pinnacle pins are worth: FMV by pin and variant, floor prices, top sales, and the market pulse on Flow — for any pin or your whole collection.',
  },
  [`collection:${PINNACLE_ID}`]: {
    title: 'Wallet Analytics — Track Your {label} Pin Collection',
    description:
      'Value any Flow wallet\'s Disney Pinnacle pins: FMV per pin, #1 and perfect serial premiums, variant and franchise breakdown, and live marketplace asks.',
  },
  [`sniper:${PINNACLE_ID}`]: {
    title: 'Sniper — {label} Pins Below FMV',
    description:
      'Disney Pinnacle pins listed below FMV, from every live listing on the Disney Pinnacle marketplace: filter by character, franchise, studio, variant and chasers.',
  },
  [`packs:${PINNACLE_ID}`]: {
    title: 'Pack Analysis — {label} Pack EV',
    description:
      'Disney Pinnacle pack expected value, modelled from pin supply and FMV (no per-tier pull odds are published), with sealed and opened counts for every pack.',
  },
  [`sets:${PINNACLE_ID}`]: {
    title: 'Set Completion — Track Your {label} Sets',
    description:
      'Disney Pinnacle set completion: which pins you hold in each set, the ones you are missing, and what the rest cost at today\'s asks.',
  },
  [`analytics:${PINNACLE_ID}`]: {
    // 2026-10-14: was "wallet analytics … acquisition history": the tab is the
    // shared MARKET analytics view (no top buyers/sellers on Pinnacle — its
    // sales live in pinnacle_sales, which that board does not read).
    title: 'Market Analytics — {label} Sales, Volume & Top Sales',
    description:
      'Disney Pinnacle market analytics: marketplace breakdown, volume, average price and daily sales by variant, top sales, and the hottest pins.',
  },
  // Panini (2026-09-28): its tabs inherited the Flow copy ("across Top Shot, All Day…",
  // "Flow wallet") — false on a Panini page. Stated from what each Panini arm reads.
  [`sniper:${PANINI_ID}`]: {
    title: 'Sniper — {label} Cards Below FMV',
    description:
      'Panini serials listed at least 15% under FMV across soccer, NBA, NFL, WNBA, MLB and NASCAR products, with #1, jersey-number and perfect-mint premiums applied and recent sales alongside — from every card RPC has seen listed on Panini.',
  },
  [`analytics:${PANINI_ID}`]: {
    title: 'Sales Analytics — {label} Sales, Volume & Top Sales',
    description:
      'Panini sales analytics across every product RPC walks — soccer, NBA, NFL, WNBA, MLB and NASCAR: sales and volume per day, top sales, most-traded editions and prices by rarity and parallel — with how completely each day is on record.',
  },
  [`packs:${PANINI_ID}`]: {
    title: 'Pack Market — {label} Pack Asks & EV',
    description:
      'Panini packs across soccer, NBA, NFL, WNBA, MLB and NASCAR: listed asks, recent sales and remaining supply, with expected value where RPC models the pack — typical pull and mean EV side by side.',
  },
  [`sets:${PANINI_ID}`]: {
    title: 'Set Progress — {label} Sets & Cost to Finish',
    description:
      'Panini sets for every product RPC walks — soccer, NBA, NFL, WNBA, MLB and NASCAR: editions seen per set and the cost to finish at confirmed asks, with unpriced editions counted apart — add a Panini username to see what that collector holds.',
  },
  [`collection:${PANINI_ID}`]: {
    title: 'Collection — {label} Cards by Panini Username',
    description:
      'Look up a Panini username: the cards on its public Panini profile (for linked collectors), or the cards RPC has read under it across the Panini products it walks, with FMV where RPC prices the card.',
  },
  // Candy MLB (2026-10-14): all six of its public tabs fell through to the Flow
  // templates ("Analyze any Flow blockchain wallet across Top Shot, All Day…") on
  // a Solana collection. Stated from what each Candy arm renders.
  [`overview:candy-mlb`]: {
    title: '{label} Value — FMV, Floor Prices & Market Pulse',
    description:
      'What Candy MLB cards are worth: FMV from real secondary sales, floor prices, top sales and the market pulse on Solana — for any card or your whole wallet.',
  },
  [`collection:candy-mlb`]: {
    title: 'Wallet Lookup — Value a {label} Collection',
    description:
      'Look up any Solana wallet or .sol name holding Candy MLB: every card it holds, valued at FMV from real secondary sales.',
  },
  [`market:candy-mlb`]: {
    title: 'Market — {label} Listings vs FMV',
    description:
      'Candy MLB listings on Magic Eden and OpenSea beside FMV, with how recently each listing was seen, so a stale ask is not mistaken for a live one.',
  },
  [`packs:candy-mlb`]: {
    title: 'Pack Market — {label} Pack Floor, Supply & Pull Value',
    description:
      'The Candy MLB sealed pack on Magic Eden: confirmed floor, asks, recent pack sales, collector-held and treasury supply, and pull value — typical pull first, chase-inclusive mean second.',
  },
  [`sets:candy-mlb`]: {
    title: 'Set Progress — Track Your {label} Checklist',
    description:
      'Candy MLB checklist progress for any Solana wallet: which cards you hold, which you are missing, and the players on the published checklist.',
  },
  [`overview:${PANINI_ID}`]: {
    title: '{label} Value — Card FMV, Floor Asks & Market Pulse',
    description:
      "What Panini Blockchain cards are worth across soccer, NBA, NFL, WNBA, MLB and NASCAR: FMV, floor asks on Panini's marketplace, top sales and the market pulse — a floor, not a census.",
  },
  [`market:${PANINI_ID}`]: {
    title: 'Market Intelligence — {label} Card Lookup & Leaderboards',
    description:
      "Card-level market intelligence for Panini Blockchain: FMV, asks on Panini's marketplace, recent sales, and liquidity and discount leaderboards across every product RPC walks.",
  },
  [`market:${PINNACLE_ID}`]: {
    title: 'Market Intelligence — {label} Pin Lookup & Leaderboards',
    description:
      'Pin-level market intelligence for Disney Pinnacle: FMV, floor asks, 30-day sales, and liquidity and discount leaderboards.',
  },
}

// ── Closed-market tab copy ──────────────────────────────────────────────────
//
// PAGE_META above is written for a LIVE market and says so in nearly every
// entry: "live FMV", "real-time FMV", "daily market pulse", "Live deals below
// FMV". On UFC Strike those are false — the Flow market's last sale was
// 2026-05-13 (lib/market-closed.ts) — and they were rendering on all five of
// its published tabs, including the ~156 monthly impressions /ufc/overview
// gets for "ufc strike value" (Search Console read, 2026-09-06). The sniper tab
// was the worst of them: "Live deals below FMV" advertises an ACTION on a
// market where nothing has traded in four months, which is the CLAUDE.md
// "never offer an action the product lacks" rule reached through metadata.
//
// ⭐ DERIVED FROM `closedMarket()`, NOT KEYED PER COLLECTION. A second
// per-slug list would have to be edited again the next time a market closes,
// and lib/market-closed.ts's own header says the opposite: "WHEN A MARKET
// REOPENS OR CLOSES, EDIT THIS MAP — not the individual pages". So the entries
// below are keyed by PAGE, apply to every closed market, and interpolate the
// venue + date from that map.
//
// ⚠ The completeness of this record is a GUARD, not a convention: every key in
// PAGE_META must have one here, asserted by
// __tests__/closed-market-tab-copy-carries-no-liveness-claim.test.ts (a ban at
// zero over CLOSED_MARKETS × PAGE_META, plus a token ban on "live"/"real-time"
// /"daily"). A new tab added to PAGE_META without a closed-market counterpart
// fails there rather than shipping a live claim on a dead market.
//
// {label} = collection display name, {venue} = the venue that closed,
// {closedOn} = "13 May 2026".
const CLOSED_MARKET_PAGE_META: Record<string, PageMeta> = {
  overview: {
    title: '{label} Value After the {venue} Market Closed — Last Prices & Sales History',
    description:
      "{label}'s {venue} marketplace closed on {closedOn}. What your moments were worth when trading stopped: last-observed FMV, final floor prices, the closing top sales, and full history — for any moment or your whole account.",
  },
  collection: {
    title: 'Wallet Analytics — Value a {label} Collection at Last Prices',
    description:
      'Analyze any Flow blockchain wallet holding {label}. The {venue} market closed on {closedOn}, so every value shown is the last observed before trading stopped — badge detection, serial premiums, and closing ask prices, marked as historical.',
  },
  sniper: {
    title: '{label} Deals — Archive of the Final {venue} Discounts',
    description:
      'The {venue} market for {label} closed on {closedOn}, so there are no deals to snipe. What remains is the record: the last discounts to FMV observed before trading stopped, per edition.',
  },
  packs: {
    title: '{label} Pack History — Final EV & Pull Odds',
    description:
      'Pack expected value and pull odds for {label} drops, computed from prices as of {closedOn} when the {venue} market closed. Historical analysis, not a buy recommendation — the packs are no longer trading.',
  },
  badges: {
    title: 'Badge Tracker — {label} Badges & Their Closing Premiums',
    description:
      'Detect badge-eligible {label} moments on any Flow blockchain wallet. Premiums for Top Shot Debut, Fresh, Rookie Year and Championship are the last observed before the {venue} market closed on {closedOn}.',
  },
  sets: {
    title: 'Set Completion — Track Your {label} Sets',
    description:
      'Set completion progress and bottleneck moments for any {label} set. Completion costs are priced at the last values before the {venue} market closed on {closedOn}, so treat them as history rather than a shopping list.',
  },
  analytics: {
    title: 'Portfolio Analytics — {label} Wallet Breakdown at Closing Values',
    description:
      'Deep-dive wallet analytics for {label}: acquisition origin, tier and series breakdown, liquid vs locked value, and portfolio clarity — all valued at the last prices before the {venue} market closed on {closedOn}.',
  },
  market: {
    title: 'Market Intelligence — {label} Edition Lookup & Closing Leaderboards',
    description:
      'Edition-level intelligence for {label}: last FMV, final ask/offer depth, and the sales that closed out the book. The {venue} market closed on {closedOn}; the leaderboards rank what happened, not what is trading.',
  },
  play: {
    title: 'Play — {label} Challenges & Final Standings',
    description:
      'Game tools for {label}: Set & Crafting Challenges, lineup optimization, and ROI tracking, scored against the last prices before the {venue} market closed on {closedOn}.',
  },
}

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
  const override = ownMeta(PAGE_META_OVERRIDES, `${page}:${collectionId}`)
  const base = PAGE_META[page]
  // A closed market takes the historical copy for this tab. The explicit
  // per-collection override still wins, so a one-off stays possible; what is NOT
  // possible is a closed market silently inheriting the live-market template.
  const cm = closedMarket(collectionId)
  const closed = cm ? ownMeta(CLOSED_MARKET_PAGE_META, page) : null
  const meta = override ?? closed ?? base
  if (!meta) return {}
  const fill = (t: string) =>
    t
      .replace(/\{label\}/g, collectionLabel)
      .replace(/\{venue\}/g, cm?.venue ?? "")
      .replace(/\{closedOn\}/g, cm ? formatClosedOn(cm.closedOn) : "")
  const title = fill(meta.title)
  const description = fill(meta.description)
  const canonical = `${BASE_URL}/${collectionId}/${page}`
  // 2026-10-14 (live audit): every tab page — all seven /overview pages, sitemap
  // priority 0.9 — had NO og:image and NO twitter:image. Next merges metadata
  // SHALLOWLY, so this openGraph object replaced the layout's (which carries the
  // card) instead of extending it. The plain collection card, deliberately
  // without `&page=`: its per-page taglines ("LIVE MARKET OVERVIEW",
  // "REAL-TIME DEALS") would be false on a closed market.
  const ogImage = `${BASE_URL}/api/og/collection?id=${encodeURIComponent(collectionId)}`
  return {
    title,
    description,
    alternates: { canonical },
    ...gatedTabRobots(page, collectionId),
    openGraph: {
      ...OG_INHERITED,
      title: `${title} | Rip Packs City`,
      description,
      url: canonical,
      images: [{ url: ogImage, width: 1200, height: 630, alt: collectionLabel }],
    },
    twitter: {
      ...TWITTER_INHERITED,
      title,
      description,
      images: [ogImage],
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

// ── Gated feature-tab shells are noindex (2026-10-11, review §3 E7) ─────────
//
// A direct URL to a tab a collection does not ship (/ufc/market, /disney-
// pinnacle/hot-floors, …) renders `FeatureTabGate`'s "isn't available" shell —
// or packs/layout.tsx's "coming soon" twin — at HTTP 200: a soft-404. The edge
// 307s only the retired set (proxy.ts RETIRED_COLLECTION_TABS); the other ~19
// shells were self-canonical and `index, follow`, so Google was being asked to
// index 19 copies of one apology. `follow` stays true: the shell links the
// Overview, which is a real page.
//
// Returns `{}` for a tab the collection DOES ship and for an unknown collection
// (that case is `unknownCollectionMetadata`'s), so the sitemap'd tabs — derived
// from the same `pages` array — are untouched by construction.
export function gatedTabRobots(page: string, collectionId: string): Pick<Metadata, 'robots'> {
  if (!getCollection(collectionId)) return {}
  if (collectionHasPage(collectionId, page as CollectionPage)) return {}
  return { robots: { index: false, follow: true } }
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
      'FMV pricing, market data, and wallet analytics for UFC Strike moments indexed on Flow (the collection has since migrated to Aptos).',
  },
  'candy-mlb': {
    title: 'Candy MLB Analytics — Rip Packs City',
    description:
      'FMV pricing from real secondary sales, floor and ask tracking, team and player pages, and market intelligence for Candy MLB collectors on Solana.',
  },
  'panini-blockchain': {
    // 2026-10-14: was "Prizm World Cup Analytics" / "Prizm World Cup 2026
    // cards" — true at launch, false since Panini went all-product (10-10:
    // soccer, NBA, NFL, WNBA, MLB, NASCAR). It is the CollectionPage JSON-LD on
    // every Panini page, so a WNBA card's page described itself as World Cup.
    title: 'Panini Blockchain Analytics — Rip Packs City',
    description:
      "FMV pricing, live asks and last sales for Panini's digital cards — soccer, NBA, NFL, WNBA, MLB and NASCAR — from every edition RPC has seen listed on Panini's marketplace. A floor, not a census.",
  },
}

// Derived from the collection registry, never hand-listed (2026-09-24). The
// hand-written copy of this map stopped at UFC, so every /candy-mlb entity
// page — 125 editions, 100 players, 30 teams, 1 set — shipped with "| Flow |"
// as its brand segment in <title>, breadcrumbs, OG and JSON-LD for a Solana
// collection. `lib/collections.ts` is the registry; a label lives there once.
// Unknown slugs still fall through to the callers' explicit "Flow" fallback.
const COLLECTION_LABELS: Record<string, string> = Object.fromEntries(
  COLLECTIONS.map(c => [c.id, c.label])
)

export function collectionLayoutMetadata(collectionId: string): Metadata {
  const meta = ownMeta(COLLECTION_LAYOUT_META, collectionId) ?? {
    title: 'Rip Packs City — Collector Intelligence',
    description:
      'The smartest analytics platform for NBA Top Shot and NFL All Day collectors. FMV pricing, set intelligence, pack EV, and a live marketplace sniper.',
  }
  const canonical = `${BASE_URL}/${collectionId}`
  const label = ownMeta(COLLECTION_LABELS, collectionId) ?? 'Flow'
  // The chain keyword follows the registry's authoritative `dbChain` — a
  // Solana collection (Candy MLB) must not advertise "Flow blockchain".
  // ⚠ A collection with NO established chain (Panini, dbChain null) gets its
  // own platform name, never "Flow blockchain" by default.
  const chainCol = COLLECTIONS.find(c => c.id === collectionId)
  const chainKeyword =
    chainCol?.dbChain === 'solana' ? 'Solana blockchain'
    : chainCol && chainCol.dbChain == null ? `${chainCol.partner ?? chainCol.label} digital collectibles`
    : 'Flow blockchain'
  // Per-collection OG image. /api/og/collection?id=<slug> renders a
  // 1200×630 card branded with the collection's icon, label, accent
  // color, and chain pill. Returns the generic fallback for unknown ids.
  const ogImage = `${BASE_URL}/api/og/collection?id=${collectionId}`
  // 2026-10-15: an id the registry does not know never renders a page — the
  // layout calls notFound() — but this metadata still decorates that 404. Live it
  // read `robots: index, follow` and a canonical + og:url naming the bad URL, so a
  // 404 claimed to be its own indexable page. No canonical, no og:url, noindex.
  const known = chainCol !== undefined
  return {
    ...(known ? {} : { robots: { index: false, follow: true } }),
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
    ...(known ? { alternates: { canonical } } : {}),
    // 'sniper deals' only where the collection HAS a Sniper tab (UFC's was retired
    // 2026-09-06; its keywords still advertised one — 2026-09-26).
    keywords: [label, 'FMV', 'moment value', 'collector tools', ...(collectionHasPage(collectionId, 'sniper') ? ['sniper deals'] : []), chainKeyword],
    openGraph: {
      ...OG_INHERITED,
      title: meta.title,
      description: meta.description,
      ...(known ? { url: canonical } : {}),
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
  // 2026-10-14 (live audit): was `/${collectionId}` — a URL that is auth-gated
  // for anon and canonicalises to /overview, so on every collection-scoped page
  // the CollectionPage @id/url and the breadcrumb's collection item named a
  // non-canonical, non-sitemap URL. The collection's public front door is /overview.
  const url = `${BASE_URL}/${collectionId}/overview`
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

// Same registry derivation as COLLECTION_LABELS above (see the note there):
// the entity-page brand label for every collection the registry knows.
const COLLECTION_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  COLLECTIONS.map(c => [c.id, c.label])
)

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

// "1 edition", never "1 editions" — a Candy player with one edition published
// "1 editions." in its meta description (2026-09-25).
function countNoun(value: number, singular: string, plural: string): string {
  return `${fmtCount(value)} ${value === 1 ? singular : plural}`
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

/**
 * Franchise hub (`/teams/<league>/<slug>`). A hub spans every collection carrying
 * the team, so there is no per-collection OG card to point at; the default card is
 * used, but the share block carries the HUB's own title, description and URL.
 * Without this the page set only title/description/alternates, so `openGraph` and
 * `twitter` fell through to the ROOT metadata and a shared hub link unfurled as
 * the homepage (no og:url, homepage copy).
 */
export function franchiseHubMetadata(opts: { name: string; description: string; canonical: string }): Metadata {
  // The brand is appended HERE, as an absolute title, never passed in from the
  // page: a page-level `title` literal carrying the brand is what the
  // double-suffix guard bans.
  const title = `${opts.name} | Rip Packs City`
  return buildMeta({ title, description: opts.description, canonical: opts.canonical, image: null })
}

/** Player hub (/players/<slug>, 2026-10-22) — same contract as franchiseHubMetadata. */
export function playerHubMetadata(opts: { name: string; description: string; canonical: string }): Metadata {
  const title = `${opts.name} | Rip Packs City`
  return buildMeta({ title, description: opts.description, canonical: opts.canonical, image: null })
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
  "9": "Series 2026-27",
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
export function editionPageMetadata(payload: Payload, collectionUrlSlug: string, titleTieBreak: string | null = null): Metadata {
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
  // 2026-09-25 — a PARALLEL printing is its own page and must carry its own
  // title: six Candy pages (Core + five Rainbow colours) shared one title and
  // one description, so a SERP could not tell them apart and Google was free to
  // fold them. The parallel comes from the edition's badges through the one
  // registry that knows the vocabulary (lib/edition-parallel.ts); Top Shot's
  // ::subedition pages already carry theirs in the slug and are unaffected.
  // 2026-10-21: the context also names the PLAY, its DATE, Top Shot's ::N
  // parallel and (All Day / Golazos) the mint size — 71 % of Top Shot edition
  // titles were shared with another edition. lib/edition-title-context.ts.
  // titleTieBreak (lib/edition/title-twins.ts): the fewest words separating this
  // edition from siblings that would otherwise render the identical title.
  const baseContext = editionTitleContext(payload, collectionUrlSlug, setName)
  const context = titleTieBreak ? `${baseContext} · ${titleTieBreak}` : baseContext
  // ⛔ NO DOLLAR FIGURE IN THE TITLE (2026-09-06, Search Console read §5).
  // The title used to interpolate the live FMV — "… · Value $1.11 | …" — which
  // is wrong on two counts. (1) It re-writes the <title> of ~20K entity URLs on
  // every crawl, so Google most often discards it and synthesizes its own; the
  // searchable half ("<Player> — <Set>", "value", "floor", "sales") is what the
  // 224 impression-bearing queries actually contain, and it was being crowded
  // out by a number nobody searches for. (2) A price in the title is a claim
  // rendered in a surface (the SERP) we cannot refresh — a cached title asserts
  // a stale valuation with no freshness signal attached, which is the honesty
  // rule applied to a surface outside the app. The value stays in the
  // DESCRIPTION, which Google shows next to it and re-reads on the same crawl.
  //
  // ⚠ The closed-market disclosure is UNCHANGED and load-bearing: the title
  // still names the closure, so a UFC/Pinnacle result cannot read as a live
  // market. See lib/market-closed.ts and the honesty pins.
  const cm = closedMarket(collectionUrlSlug)
  const title = cm
    ? `${subject} — ${context} · Value History & Sales (${cm.venue} market closed) | ${collectionLabel} | Rip Packs City`
    : collectionUrlSlug === "panini-blockchain"
      ? `${subject} — ${context} · Value & Asks | ${collectionLabel} | Rip Packs City`
      : `${subject} — ${context} · Value, Floor & Sales | ${collectionLabel} | Rip Packs City`
  // Review E4 (2026-10-12): when get_edition_detail carries the edition's
  // upstream prose, its FIRST SENTENCE (≤ 160 chars) seeds the description, so
  // a SERP reads what the play IS before the template's value sentence. Absent,
  // empty or whitespace-only prose is null here and the description is exactly
  // what it was — never an empty lead, never a stand-in.
  const prose = editionDescriptionSnippet(payload.description)
  const descParts = [
    prose,
    cm
      ? (fmvUsd
          ? `${subject} ${context} last traded around ${fmtUsd(fmvUsd)} on ${collectionLabel} before its ${cm.venue} market closed on ${formatClosedOn(cm.closedOn)}. Historical value, not a present-day price.`
          : `${subject} ${context} on ${collectionLabel} — historical value and sales. The ${cm.venue} market closed on ${formatClosedOn(cm.closedOn)}.`)
      : (fmvUsd
          ? `${subject} ${context} is worth ~${fmtUsd(fmvUsd)} (FMV) on ${collectionLabel}.`
          : collectionUrlSlug === "panini-blockchain"
            ? `${subject} ${context} on ${collectionLabel} — fair-market value and live asks.`
            : `${subject} ${context} on ${collectionLabel} — live fair-market value, floor, and recent sales.`),
    tier ? `Tier ${tier}.` : null,
    seriesLabel ? `${formatSeriesLabel(seriesLabel, collectionUrlSlug)}.` : null,
    circulation ? `Circulation ${fmtCount(circulation)}.` : null,
    null,
    // ⛔ CONDITIONAL. This tail used to be unconditional, so a CLOSED-market
    // description said "Historical value, not a present-day price. … Live FMV,
    // recent sales, …" — contradicting itself inside one sentence run, on every
    // UFC edition page. Found 2026-09-06 by reading a live one, not by grep.
    //
    // ⭐ THE SAME FILE ALREADY GOT THIS RIGHT twenty lines below: editionJsonLd's
    // Product.description branches on isMarketClosed() for exactly this string.
    // One helper right, its neighbour wrong — which is why the guard now walks
    // ALL FIVE entity helpers instead of pinning the one that was found.
    //
    // ⓘ MEASURED, not assumed: the set / player / team / series helpers do NOT
    // share this bug — they route their FMV through fmvClosedQualifier(). This
    // was one defect, not five.
    cm
      ? "Sales history, the FMV history chart, and the packs that contained this edition."
      // Panini (2026-09-27): no recorded sales feed and no pack pool per edition —
      // the page shows FMV, live asks and the last sale seen per card.
      : collectionUrlSlug === "panini-blockchain"
        ? "FMV, live asks on Panini's marketplace, the last sale seen per card, and FMV history."
        : "Live FMV, recent sales, history chart, and packs that contained this edition.",
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
    editionCount ? `${countNoun(editionCount, "edition", "editions")}.` : null,
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
  // Panini (2026-09-27) sells CARDS, and records no sales feed to take a top sale from.
  const isPanini = collectionUrlSlug === "panini-blockchain"
  const title = `${name} — ${isCharacter ? "Pins" : isPanini ? "Cards" : "Moments"} & Market Value | ${collectionLabel} | Rip Packs City`
  const descParts = [
    `${name} (${noun}) on ${collectionLabel}.`,
    team ? `${teamLabel}: ${team}.` : null,
    // A Pinnacle character page counts PINS (the render catalog, 2026-09-26).
    editionCount ? `${isCharacter ? countNoun(editionCount, "pin", "pins") : countNoun(editionCount, "edition", "editions")}.` : null,
    fmvTotal ? `Portfolio FMV ${fmtUsd(fmvTotal)}${fmvClosedQualifier(collectionUrlSlug)}.` : null,
    isCharacter ? "Pin grid, top sale, and set breakdown." : isPanini ? "Card grid, live asks, and set breakdown." : "Edition grid, top sale, and set breakdown.",
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
  const title = `${teamName} — ${isFranchise ? "Pins" : "Moments"} & Market Value | ${collectionLabel} | Rip Packs City`
  const descParts = [
    `${teamName} ${noun.toLowerCase()} on ${collectionLabel}.`,
    playerCount ? `${isFranchise ? countNoun(playerCount, "character", "characters") : countNoun(playerCount, "player", "players")}.` : null,
    // A Pinnacle franchise page counts PINS (the render catalog, 2026-09-26).
    editionCount ? `${isFranchise ? countNoun(editionCount, "pin", "pins") : countNoun(editionCount, "edition", "editions")}.` : null,
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
  // 2026-09-24: the same label the edition/set/moment pages use for a Top Shot
  // series (TS_SERIES_DISPLAY — "Series 2025-26", not the retired "Series 7"),
  // so the series page's title matches every page that links to it.
  const seriesNumber = n(payload, "series_number")
  const tsLabel = collectionUrlSlug === "nba-top-shot" && seriesNumber != null ? TS_SERIES_DISPLAY[String(seriesNumber)] : undefined
  const displayLabel = tsLabel ?? s(payload, "display_label") ?? "Series"
  const season = s(payload, "season")
  const editionCount = n(payload, "edition_count")
  const setCount = n(payload, "set_count")
  const playerCount = n(payload, "player_count")
  const fmvTotal = n(payload, "fmv_total_usd")
  const subject = displayLabel
  // Skip "(Season X)" when the label already IS the season.
  const seasonSuffix = season && !displayLabel.includes(season) ? ` (Season ${season})` : ""
  const title = `${subject}${seasonSuffix} — ${collectionLabel} Editions & Values | Rip Packs City`
  const descParts = [
    `${displayLabel} on ${collectionLabel}.`,
    season && !displayLabel.includes(season) ? `Season ${season}.` : null,
    editionCount ? `${countNoun(editionCount, "edition", "editions")}.` : null,
    setCount ? `${countNoun(setCount, "set", "sets")}.` : null,
    playerCount ? `${countNoun(playerCount, "player", "players")}.` : null,
    fmvTotal ? `Aggregate FMV ${fmtUsd(fmvTotal)}${fmvClosedQualifier(collectionUrlSlug)}.` : null,
    "Top editions, set breakdown, and player leaderboard.",
  ].filter(Boolean) as string[]
  const description = descParts.join(" ")
  const canonical = `${BASE_URL}/${collectionUrlSlug}/series/${encodeURIComponent(seriesSlug)}`
  const og = seriesSlug ? `${BASE_URL}/api/og/series?collection=${collectionUrlSlug}&slug=${encodeURIComponent(seriesSlug)}` : null
  // 2026-10-17: a series that GENUINELY holds 0 editions (UFC Series 0, measured)
  // is a contentless page — noindex,follow, like the gated tab shells above.
  // `=== 0` only: a NULL edition_count is an un-rolled-up series (UNKNOWN), and
  // must stay indexable (see the page's isEmpty note).
  if (editionCount === 0) {
    return { ...buildMeta({ title, description, canonical, image: og }), robots: { index: false, follow: true } }
  }
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

/**
 * The collection rung of an entity breadcrumb. `/<collection>` itself 307s to
 * `/<collection>/overview` (2026-10-21, measured), and a BreadcrumbList item
 * should name the URL that answers 200 — the same one collectionPageJsonLd uses.
 */
export function collectionCrumbUrl(collectionUrlSlug: string): string {
  return `${BASE_URL}/${collectionUrlSlug}/overview`
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
//
// 🚨 lowAskUpdatedAt ADDED 2026-08-29, and it closes a hole the rest of this function
// was already careful about. The signature had NO timestamp at all, so a stale ask was
// structurally unqualifiable — and on 2026-08-29 `offers-sweep` had not confirmed an
// ask in 31 hours while this function published every one of them to Google as
// `availability: InStock`, with no expiry. The premise is written down four lines
// below: *"a live low ask is still a real, reliable price even on STALE."* **That is
// the sentence that broke** — it was true of a feed that re-checked hourly and false
// of one that had stopped.
/**
 * Hours since an ask was last confirmed. `undefined` when the caller supplied no
 * timestamp at all (legacy), `null` when it supplied one we cannot read.
 */
function askAgeHoursFrom(iso: string | null | undefined): number | null | undefined {
  if (iso === undefined) return undefined
  if (iso === null) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return (Date.now() - t) / 3_600_000
}

export function editionJsonLd(
  detail: Payload,
  collectionUrlSlug: string,
  lowAsk?: number | null,
  /**
   * When `lowAsk` was last CONFIRMED (edition_offers.updated_at). Three states:
   *   - an ISO string → dated; drives the expiry / suppression below
   *   - `null`        → we hold an ask we cannot date → treated as ANCIENT, no Offer
   *   - omitted       → caller is not age-aware (legacy path, prior behaviour)
   * ⚠ The null case is stricter than the omitted case, for the same reason as in
   * lib/fmv-confidence.ts: an undatable ask is exactly what this gate exists to catch.
   */
  lowAskUpdatedAt?: string | null,
): LdValue {
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
    // 2026-10-21: same disambiguated context as the <title> (lib/edition-title-context.ts),
    // so two editions of one player in one set are not two identical Products.
    name: `${playerName} — ${editionTitleContext(detail, collectionUrlSlug, setName ?? label)}`,
    brand: { "@type": "Brand", name: label },
    image: thumb || ogImage || `${BASE_URL}/api/og/default`,
    description: `${playerName}${setName ? " — " + setName : ""}${tier ? " (" + tier + ")" : ""} on ${label}. ${
      isMarketClosed(collectionUrlSlug)
        ? `Historical value and sales history — the ${closedMarket(collectionUrlSlug)!.venue} market for this collection closed on ${formatClosedOn(closedMarket(collectionUrlSlug)!.closedOn)}.`
        : collectionUrlSlug === "panini-blockchain"
          ? "FMV, live asks on Panini's marketplace, the last sale seen per card, and FMV history."
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
  // ⚠ THE ASK BRANCH IS THE ONLY ONE THAT NEEDS AN AGE. When `fmvUsable`, the price
  // is a modelled FMV and the ask's age is irrelevant to it — gating that branch would
  // suppress Offers for no reason. So the age only bites where the ask IS the price.
  const priceFromAsk = priceUsd !== null && !fmvUsable
  const askAgeHours = priceFromAsk ? askAgeHoursFrom(lowAskUpdatedAt) : undefined
  // ⛔ Beyond the corroboration bound an ask has stopped being evidence (see
  // lib/fmv-confidence.ts for the measurement behind that number), so publish nothing
  // rather than a price we cannot stand behind. `null` — an ask we hold and cannot
  // date — lands here too.
  const askTooOldToPublish =
    priceFromAsk && (askAgeHours === null || (askAgeHours ?? 0) >= MAX_ASK_AGE_HOURS_CORROBORATION)
  if (priceUsd !== null && !askTooOldToPublish) {
    const offer: Payload = {
      "@type": "Offer",
      price: Math.round(priceUsd * 100) / 100,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url,
    }
    // ⭐ `priceValidUntil` RATHER THAN DROPPING THE OFFER, for the merely-stale case.
    // schema.org has a field for exactly this claim, and it is the honest one: we
    // vouch for the price until ASK_STALE_HOURS past the last time we CONFIRMED it,
    // and no further. A fresh ask therefore carries a future expiry (accurate); a
    // 31-hour-old one carries a past expiry (also accurate, and Google reads an
    // elapsed priceValidUntil as a reason to distrust the price rather than to trust
    // it). ⚠ Dropping the Offer outright at 12 h was the alternative and is worse for
    // readers: it deletes the Product rich-result from thousands of NO_DATA edition
    // pages during any upstream outage — an SEO cost with no honesty gain over an
    // accurate expiry.
    if (priceFromAsk && typeof askAgeHours === "number") {
      const confirmedAtMs = Date.parse(String(lowAskUpdatedAt))
      if (!Number.isNaN(confirmedAtMs)) {
        offer.priceValidUntil = new Date(confirmedAtMs + ASK_STALE_HOURS * 3_600_000)
          .toISOString()
          .slice(0, 10)
      }
    }
    product.offers = offer
  }
  return {
    "@context": "https://schema.org",
    "@graph": [
      // No Offer → not a Product (an offer-less Product is an invalid snippet): lib/jsonld-product.ts
      productOrCreativeWork(product),
      breadcrumbJsonLd([
        { name: "Home", url: BASE_URL },
        { name: label, url: collectionCrumbUrl(collectionUrlSlug) },
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
        { name: label, url: collectionCrumbUrl(collectionUrlSlug) },
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
        { name: label, url: collectionCrumbUrl(collectionUrlSlug) },
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
      // The page each tile links to (a Pinnacle pin's own page, not the
      // /disney-pinnacle/edition/ URL that only redirects there — 2026-09-27).
      url: `${BASE_URL}${editionRouteHref(opts.collectionUrlSlug, s(e, "route_slug") ?? "")}`,
    }
    const nm = s(e, "player_name") ?? s(e, "name")
    const img = proxyIpfsUrlAbsolute(s(e, "thumbnail_url"), BASE_URL)
    if (nm) li.name = nm
    if (img) li.image = img
    return li
  })
  const page: LdValue = {
    "@type": "CollectionPage",
    "@id": opts.url,
    url: opts.url,
    name: opts.name,
    isPartOf: { "@type": "WebSite", name: "Rip Packs City", url: BASE_URL },
  }
  // ⚠ THREE states, not two. The pages gate this whole script on the editions
  // read SUCCEEDING, which handles the failed read. A read that succeeded and
  // returned NOTHING is the third state, and until 2026-09-18 it published
  // `numberOfItems: 0` — a machine-readable "this set holds no editions" that a
  // crawler cannot tell from a measured zero (deep-audit R58, residual a). An
  // empty list is no claim: omit the ItemList and keep the CollectionPage and
  // its breadcrumb, which are true regardless.
  if (items.length > 0) {
    page.mainEntity = { "@type": "ItemList", numberOfItems: items.length, itemListElement: items }
  }
  return {
    "@context": "https://schema.org",
    "@graph": [
      page,
      breadcrumbJsonLd([
        { name: "Home", url: BASE_URL },
        { name: label, url: collectionCrumbUrl(opts.collectionUrlSlug) },
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
      productOrCreativeWork(product),
      breadcrumbJsonLd([
        { name: "Home", url: BASE_URL },
        { name: label, url: collectionCrumbUrl(opts.collectionUrlSlug) },
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
