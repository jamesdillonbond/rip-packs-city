// app/(collections)/[collection]/edition/[slug]/page.tsx
// Phase 1B. Edition detail page for all 5 published collections.
//
// Data: get_edition_detail + get_edition_recent_sales + get_edition_fmv_history
// + get_edition_in_packs server-side. Special serials read directly from
// special_serial_holders for non-Pinnacle collections.

import type { Metadata } from "next"
import { Suspense } from "react"
import Link from "next/link"
import { notFound, permanentRedirect } from "next/navigation"
import SpecialSerialGlyph from "@/components/SpecialSerialGlyph"
import LoadingState from "@/components/ui/LoadingState"
import { getCollectionByUrlSlug, isPinnacleUrlSlug } from "@/lib/collection-slug"
import { fetchEntityDetailRaw } from "@/lib/entity-detail-gate"
import { sectionRows, sectionRowsResult } from "@/lib/entity-section-rpc"
import { sectionEmptyCopy } from "@/lib/entity/section-empty-copy"
import {
  fetchMarketBundle,
  fetchInsightLinks,
  type HighOffer,
  type IpfsAsset,
  type SubeditionSibling,
  type MarketBundle,
  type InsightLinks,
  EMPTY_INSIGHT_LINKS,
} from "@/lib/entity/edition-market-fetchers"
import { fetchPackProvenance, fetchOwnerUsernames, type PackProvenanceRow } from "@/lib/edition/fetchers"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import { editionPageMetadata, editionJsonLd, collectionDisplayName, NOT_FOUND_METADATA } from "@/lib/seo"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import MomentHeroMedia from "@/components/MomentHeroMedia"
import { proxyIpfsUrl } from "@/lib/ipfs-media"
import PackThumb from "@/components/packs/PackThumb"
import { slugifyName } from "@/lib/entity-labels"
import { isTopShotFossilSlug, ASK_LABEL, notableTagLabel, fmvDayDelta, sortNotableSerials } from "@/lib/edition-detail-format"
import { normalizeBadgeKey } from "@/lib/badges/normalize"
import { fetchBadgeArt } from "@/lib/badges/server-art"
import {
  EM_DASH,
  FmvBasis,
  Section,
  StatCell,
  TierBadge,
  WalletLink,
  fmtCount,
  fmtPercent,
  fmtUsd,
  relTime,
} from "@/components/entity/_shared"
import FmvHistoryChart from "@/components/entity/FmvHistoryChart"
import EditionActivity from "@/components/entity/EditionActivity"
import ParallelTierSwitcher from "@/components/entity/ParallelTierSwitcher"
import { MarketplaceStatusBanner } from "@/components/marketplace-status"
import { isMarketClosed } from "@/lib/market-closed"
import { fmvBasis } from "@/lib/fmv-basis"
import WatchEditionButton from "@/components/alerts/WatchEditionButton"
import TrackedOutboundLink from "@/components/TrackedOutboundLink"
import { dapperMarketEditionUrl } from "@/lib/collections"

export const revalidate = 600
export const dynamicParams = true

export async function generateStaticParams() {
  return [] as Array<{ collection: string; slug: string }>
}

interface EditionDetail {
  id: string
  source: string | null
  collection_id: string
  collection_slug: string
  route_slug: string
  external_id: string | null
  name: string | null
  player_name: string | null
  set_name: string | null
  set_slug: string | null
  tier: string | null
  series_label: string | null
  series_num: number | null
  edition_kind: string | null
  circulation_count: number | null
  badges: string[] | null
  thumbnail_url: string | null
  video_url: string | null
  team_name: string | null
  first_minted_at: string | null
  fmv: {
    fmv_usd: number | null
    floor_price_usd: number | null
    wap_usd: number | null
    confidence: string | null
    computed_at: string | null
    sales_count_30d: number | null
    days_since_sale: number | null
    cross_market_ask?: number | null
    // PIN-FMV-REKEY Wave 2: per-render spread for Pinnacle set-level keys.
    fmv_min?: number | null
    fmv_max?: number | null
    render_count?: number | null
  } | null
  is_serialized?: boolean
  is_chaser?: boolean
  live_ask?: { price: number | null; source: string | null; updated_at: string | null } | null
}

interface SaleRow {
  serial_number: number | null
  price_usd: number | null
  marketplace: string | null
  source: string | null
  buyer_address: string | null
  seller_address: string | null
  nft_id: string | null
  transaction_hash: string | null
  sold_at: string | null
  // Top Shot only — which printing (Standard / Hexwave / ...) the sale belongs
  // to, resolved per-NFT server-side. NULL on other collections (column hidden).
  parallel?: string | null
}

interface HistoryRow {
  day: string
  fmv_usd: number | null
  wap_usd: number | null
  floor_usd: number | null
  confidence: string | null
  sales_count_30d: number | null
  computed_at: string | null
}

interface PackRow {
  dist_id: string
  drop_weight: number | null
  slot_name: string | null
  last_refreshed_at: string | null
  pack_title: string | null
  pack_image_url: string | null
  total_minted: number | null
  total_sealed: number | null
  depletion_pct: number | null
}

interface ParallelEdition {
  id: string
  external_id: string | null
  set_name: string | null
  tier: string | null
  series: number | null
  circulation_count: number | null
  thumbnail_url: string | null
  set_id_onchain: number | null
  player_name: string | null
}

// NOTE: SubeditionSibling — same setID:playID base, different printing
// (Standard / Hexwave / Jukebox / …), each its OWN edition with its own
// circulation and per-parallel FMV — now lives in
// lib/entity/edition-market-fetchers.ts alongside the bundle that returns it.
// It is DISTINCT from ParallelEdition above (same-play / DIFFERENT-set); the two
// are easy to confuse and drive different sections.

const SALES_PAGE_SIZE = 30

// The ~6,404 inert UUID-keyed Top Shot fossil editions resolve through
// get_edition_detail but are thin near-duplicates of the canonical int-pair
// editions (NULL on-chain ids, no thumbnail, no FMV) — Google flags them as
// duplicate-canonical. isTopShotFossilSlug + ASK_LABEL + notableTagLabel are
// extracted to @/lib/edition-detail-format (measured by the coverage ratchet);
// imported below. Bodies are byte-identical.

// Routed through the shared cache()'d fetch so the segment layout's 404 gate,
// generateMetadata and this render collapse into ONE get_edition_detail call per
// request. See lib/entity-detail-gate.ts.
async function fetchDetail(collectionId: string, routeSlug: string): Promise<EditionDetail | null> {
  const { data, error } = await fetchEntityDetailRaw("edition", collectionId, routeSlug)
  if (error) {
    // Transient RPC failure (statement timeout under contention) must NOT render
    // as not-found — that soft-404s a real page, and edition is the largest of
    // the five SEO entity routes by URL count. Returning null fed the page's
    // `if (!detail) notFound()`, and it also defeated the layout gate, which
    // fails open precisely so "a transient pool blip must never emit a 404 and
    // invite Google to drop a real page".
    // Same fix already shipped on set / player / team (2026-07-14); edition and
    // series were missed (deep-audit D10). Throw -> retryable error boundary.
    console.error("[edition] get_edition_detail error", error.message)
    throw new Error(`edition detail unavailable: ${error.message}`)
  }
  if (!data) return null
  if (Array.isArray(data)) return (data[0] as EditionDetail) ?? null
  return data as EditionDetail
}

async function fetchSales(collectionId: string, routeSlug: string, limit: number, offset = 0): Promise<SaleRow[]> {
  return (await fetchSalesResult(collectionId, routeSlug, limit, offset)).rows
}

/**
 * The three-state form, for the Activity block. ⚠ `ok` has to survive BOTH
 * erasers: `sectionRows` degrading a decorative failure to `[]`, and the
 * `.catch(() => [])` in the section fan-out below. Either one alone puts an
 * empty array in front of the reader, and the table then says "No sales yet."
 */
async function fetchSalesResult(
  collectionId: string,
  routeSlug: string,
  limit: number,
  offset = 0,
): Promise<{ rows: SaleRow[]; ok: boolean }> {
  const { rows, ok } = await sectionRowsResult<SaleRow>("edition recent sales", "get_edition_recent_sales", {
    p_collection_id: collectionId,
    p_route_slug: routeSlug,
    p_limit: limit,
    p_offset: offset,
  })
  return { rows, ok }
}

// Feature 2 — open standing offers for the Activity section's "Offers" tab.
// public.offers (status=open), Top-Shot-only on-chain today; other collections
// return [] and the tab shows an empty state.
interface OfferRow {
  serial_number: number | null
  price_usd: number | null
  buyer_address: string | null
  offer_type: string | null
  made_at: string | null
}

async function fetchOffers(editionId: string, limit: number): Promise<{ rows: OfferRow[]; ok: boolean }> {
  return sectionRowsResult<OfferRow>("edition offers", "get_edition_offers", { p_edition_id: editionId, p_limit: limit })
}

async function fetchHistory(collectionId: string, routeSlug: string, days: number): Promise<HistoryRow[]> {
  return sectionRows<HistoryRow>("edition FMV history", "get_edition_fmv_history", {
    p_collection_id: collectionId,
    p_route_slug: routeSlug,
    p_days: days,
  })
}

async function fetchPacks(collectionId: string, routeSlug: string): Promise<PackRow[]> {
  return sectionRows<PackRow>("edition in-packs", "get_edition_in_packs", {
    p_collection_id: collectionId,
    p_route_slug: routeSlug,
  })
}

// Pack provenance (Top Shot + All Day) — what share of this edition's circulation
// we've observed entering the market via pack opens. Reads the public
// v_topshot_edition_pull_provenance / v_allday_edition_pull_provenance views
// keyed by edition_id. Window-bounded (TS ~Apr 2026 →, AllDay ~Jun 2026 →) and
// undercounts because not every pulled NFT resolves to its edition, so this is a
// directional "pack-distributed" signal, not a precise fraction (copy reflects that).
// Item 3b — the deterministic notable-serial breakdown (tags + last sale) from
// get_edition_special_serials. Complements special_serial_holders (which carries
// the tracked OWNER, omitted from this RPC's v1 due to partial coverage) — the
// page merges the two by serial.
interface NotableSerialRow {
  serial: number
  tag: string
  last_sale_usd: number | null
  last_sold_at: string | null
  // Current holder from wallet_moments_cache where we've indexed that serial
  // (added 2026-06-13 — fills the owner column the empty special_serial_holders
  // table never could).
  holder_address: string | null
  nft_id: string | null
}

// Three-state: this section's empty copy CONCLUDES ("No notable serials … yet."),
// so a degraded read must not be published as a fact about the edition.
async function fetchNotableSerials(editionId: string): Promise<{ rows: NotableSerialRow[]; ok: boolean }> {
  return sectionRowsResult<NotableSerialRow>("edition special serials", "get_edition_special_serials", { p_edition_id: editionId })
}

// Top Owners (v2 "Most Owned") — the biggest holders of this edition from the
// Dune-sourced current-season ownership index (get_edition_top_owners). Returns
// [] for editions not yet covered by the index, so the section renders only
// where holder data is COMPLETE. Top Shot only.
interface TopOwnerRow {
  owner_address: string
  moment_count: number
  low_serial: number | null
  total_holders: number
  total_moments: number
}

async function fetchTopOwners(editionId: string): Promise<TopOwnerRow[]> {
  return sectionRows<TopOwnerRow>("edition top owners", "get_edition_top_owners", { p_edition_id: editionId, p_limit: 10 })
}

// Resolve owner wallet addresses → @username so the Special Serials owner cell
// matches the Recent Sales rows (which resolve usernames client-side). The
// special-serials section is server-rendered, so we read wallet_usernames here.
// (Item 7, 2026-06-22 audit.)
// Market bundle — high_offer + subedition (parallel) ladder + IPFS assets in ONE
// pooled connection (get_edition_market_bundle composes the three SECDEF helpers
// server-side). Cuts the edition-page hero fan-out from 3 round-trips to 1,
// easing the PostgREST connection-pool pressure that dominates edition-page
// errors. (2026-07-01 fan-out reduction — continues the get_edition_insight_links
// bundling.) high_offer.low_ask now carries the live NFL All Day floor ask.
// The seven list-shaped section fetchers above go through
// lib/entity-section-rpc.ts: connection-class errors retry before surfacing, and
// a failure that survives them logs under a greppable `[entity-section]` prefix
// instead of being indistinguishable from a genuinely empty tab. None is marked
// structural — the edition hero carries the page, and these are tab contents.
//
// The two fetchers BELOW are deliberately NOT converted to sectionRows: each has
// a bespoke non-empty default (EMPTY_MARKET_BUNDLE / EMPTY_INSIGHT_LINKS) rather
// than [], so routing them through it would change their contract. They keep
// their own error handling.
//
// They DO go through rpcWithRetry directly (2026-08-13), which is a different
// thing and was the gap: both sit in this page's blocking shell Promise.all, and
// a bare .rpc() has no wall-clock bound at all, so a stuck connection-acquire
// parked the whole render on "SCANNING THE MARKETPLACE…" until Vercel killed the
// function at 300s. rpcWithRetry returns the same { data, error } shape these
// already destructure, so the contract is unchanged — it only adds the bound
// (and the retry the rest of the page had). market_bundle is the single most
// frequent edition error in production, so leaving it unbounded would have left
// the hang in place on the exact page that reported it.

async function fetchParallels(editionId: string): Promise<ParallelEdition[]> {
  return sectionRows<ParallelEdition>("edition parallels", "get_edition_parallels", { p_edition_id: editionId })
}

// "Featured in Insights" membership — Top Shot only. Reads the same public
// boards the /insights surfaces render (security_invoker views, anon SELECT):
// squeeze_pct (topshot_squeeze_board), discount_pct (topshot_deals_vs_fmv,
// keyed on external_id), and the first-mint multiplier
// (topshot_first_mint_trophies). Closes the entity → insights link direction.


// IPFS CID data still arrives on the market bundle (topshot_ipfs_assets) but
// is no longer rendered — the "Media Verified on IPFS" section was removed
// 2026-07-11 (Trevor: build-time plumbing, not front-end content). The type
// stays so the bundle shape remains documented.

const INSIGHT_CHIP_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  border: "1px solid var(--rpc-red-border, var(--rpc-border))",
  background: "var(--rpc-red-bg, rgba(224,58,47,0.08))",
  borderRadius: 4,
  fontSize: 12,
  letterSpacing: "0.04em",
  color: "var(--rpc-red)",
  textDecoration: "none",
}

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(
  props: { params: Promise<{ collection: string; slug: string }> }
): Promise<Metadata> {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return NOT_FOUND_METADATA
  // Pinnacle edition pages are retired in favor of the render-keyed per-pin
  // surface at /pinnacle/moment/<render_id> (which also disambiguates legacy
  // set-level keys). Funnel all Pinnacle edition URLs there. (Item 2, 2026-06-26.)
  if (isPinnacleUrlSlug(collection)) permanentRedirect(`/pinnacle/moment/${encodeURIComponent(slug)}`)
  if (isTopShotFossilSlug(collection, slug)) return NOT_FOUND_METADATA
  // ⚠ BOUNDED (deep-audit R19). Measured over 7 days to 2026-08-23:
  // "edition detail unavailable: rpc get_edition_detail timed out after 45000ms"
  // threw 15,388 times across 2,963 DISTINCT USERS, and a large share of the
  // stacks are `at async Module.V [as generateMetadata]` — i.e. here.
  //
  // ⚠ A THROW IN generateMetadata IS THE WORST PLACE FOR ONE: no error boundary
  // wraps metadata generation, so it takes the whole response down to Next's
  // unbranded default 500 before the page ever renders.
  //
  // A transient failure must NOT return NOT_FOUND_METADATA — that tells a
  // crawler a real, indexed edition is gone. Generic non-404 title instead,
  // mirroring the set page.
  let detail: Awaited<ReturnType<typeof fetchDetail>> = null
  try {
    detail = await fetchDetail(coll.id, slug)
  } catch {
    return { title: `${slug} | ${coll.displayName} | Rip Packs City` }
  }
  if (!detail) return NOT_FOUND_METADATA
  return editionPageMetadata(detail as unknown as Record<string, unknown>, collection)
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function EditionPage(
  props: { params: Promise<{ collection: string; slug: string }> }
) {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()
  // Pinnacle edition pages → the render-keyed per-pin page (Item 2, 2026-06-26).
  // The moment page resolves a render_id directly and a legacy set-level key to a
  // disambiguation list, so no Pinnacle edition URL ever shows an arbitrary pin.
  if (isPinnacleUrlSlug(collection)) permanentRedirect(`/pinnacle/moment/${encodeURIComponent(slug)}`)
  if (isTopShotFossilSlug(collection, slug)) notFound()

  // ⚠ BOUNDED (R19). Same read, same timeout. `!detail` means the RPC answered
  // and this edition does not exist (404 true); a THROW means we could not ask,
  // and 404-ing there de-indexes a real page.
  let detail: Awaited<ReturnType<typeof fetchDetail>> = null
  let detailFailed = false
  try {
    detail = await fetchDetail(coll.id, slug)
  } catch {
    detailFailed = true
  }
  if (detailFailed) return <EditionUnavailable collection={collection} slug={slug} />
  if (!detail) notFound()

  const isPinnacle = isPinnacleUrlSlug(collection)

  // Fast shell — only the cheap single-row / aggregate RPCs the hero + FMV strip
  // need. The heavy bottom sections (recent sales, parallels, packs, special
  // serials + owner-username resolution) stream in below via <Suspense>, so the
  // headline FMV paints after ~1 RPC instead of waiting on the full fan-out. The
  // route loading.tsx ("SCANNING THE MARKETPLACE…") now only covers this shell.
  // (2026-06-23 — decouple FMV display from the slower market fetches.)
  // ⚠ BOUNDED (R19). Measured: this block runs 5 fetches with ZERO per-member
  // .catch(), unlike the streamed block further down which catches all 7. Any
  // one of them throwing takes the page to Next's unbranded 500 — and on an ISR
  // route error.tsx does not run, so nothing else can catch it.
  //
  // Whole-page degradation here rather than per-section because the render below
  // consumes these unconditionally; per-section is the better end state and is
  // filed, not done.
  let history: Awaited<ReturnType<typeof fetchHistory>>
  let bundleRes: Awaited<ReturnType<typeof fetchMarketBundle>>
  let insightRes: Awaited<ReturnType<typeof fetchInsightLinks>>
  let badgeArt: Awaited<ReturnType<typeof fetchBadgeArt>>
  let repSales: Awaited<ReturnType<typeof fetchSales>>
  try {
    ;[history, bundleRes, insightRes, badgeArt, repSales] = await Promise.all([
    fetchHistory(coll.id, slug, 30),
    // high_offer + subedition (parallel) ladder + IPFS assets in ONE round-trip.
    fetchMarketBundle(detail.id, detail.external_id),
    collection === "nba-top-shot"
      ? fetchInsightLinks(detail.id, detail.external_id)
      // ⚠ `ok: true` on the skip, deliberately. Insight links are Top Shot only,
      // so NOT APPLICABLE is not a failure — marking it `ok: false` would put
      // every non-Top-Shot edition page into a permanent degraded state, the
      // cry-wolf outcome lib/insights/board-status.ts warns about.
      : Promise.resolve({ data: EMPTY_INSIGHT_LINKS, ok: true }),
    // Real badge artwork (SVGs) keyed by normalized title; absent titles fall
    // back to the existing text pill. (2026-06-15)
    fetchBadgeArt(detail.badges ?? [], coll.id),
    // One representative sale → the resilient hero-media nft id (the
    // media/<nftId>/image form that survives the legacy-CDN 404s). The full
    // sales page is fetched in the streamed bottom block.
      fetchSales(coll.id, slug, 1, 0),
    ])
  } catch {
    return <EditionUnavailable collection={collection} slug={slug} />
  }
  // `.data` only — see lib/entity/edition-market-fetchers.ts on why `ok` is not
  // consumed here: every render site below gates on `!= null` / `length >= 2`,
  // so a failed read degrades to an em-dash or a hidden section rather than a
  // fabricated 0. `ok` exists for the first consumer that wants to render a
  // figure unconditionally.
  const bundle = bundleRes.data
  const insightLinks = insightRes.data
  const highOffer = bundle.high_offer
  // Top Shot subedition (parallel) ladder — Standard + each ::sub printing.
  const subSiblings = bundle.subedition_siblings

  // The current edition's own parallel printing (Hexwave/Jukebox/… or Standard)
  // and whether a multi-printing ladder exists. Drives the hero chip + module.
  const currentSibling = subSiblings.find((s) => s.is_self) ?? null
  const hasParallelLadder = subSiblings.length >= 2

  // Feature 1 — "% Listed" = open listings ÷ supply. Supply is per-printing
  // honest: on a ::subID parallel page use that printing's own circulation.
  // active_listings is null when the collection has no fresh listing source
  // (Top Shot's ts_listings feed is dead) → render em-dash, not a fake 0%.
  const listedSupply = currentSibling?.circulation_count ?? detail.circulation_count
  const pctListed =
    bundle.active_listings != null && listedSupply != null && listedSupply > 0
      ? (bundle.active_listings / listedSupply) * 100
      : null

  const hasInsightLinks =
    insightLinks.squeeze_pct != null ||
    insightLinks.deal_pct != null ||
    insightLinks.first_mint_x != null

  const fmv = detail.fmv
  const fmvAvailable = fmv && fmv.fmv_usd !== null
  // Market-closure honesty (2026-08-04). A closed market (UFC) carries the last
  // value forward with a fresh computed_at, so a "Current FMV $X / worth ~$X"
  // claim reads as live on a market frozen 400+ days ago. Suppress the hero
  // dollar + the crawlable "is worth $X" prose; the MarketplaceStatusBanner above
  // explains the closure and the "30d Sales · Nd since last" stat stays honest
  // (its count is zeroed at the data layer). Same fix as the /moment page + OG.
  const marketClosed = isMarketClosed(collection)

  // Outbound EDITION-grain marketplace link. The native marketplaces are
  // deep-linkable at MOMENT grain only (see the comment on marketplaceMomentUrl
  // in lib/collections.ts), which is why this page has carried no outbound CTA
  // at all; dapper.market publishes a real per-EDITION page keyed by the same
  // external_id we already hold, so this one link is honestly buildable.
  // Returns null for every collection without a verified edition-URL shape, so
  // the CTA self-hides rather than guessing. Suppressed on a closed market —
  // UFC is not in the seg map today, but a future entry must not resurrect a
  // "go buy this" CTA for a venue that stopped trading.
  const dapperEditionUrl = marketClosed
    ? null
    : dapperMarketEditionUrl(collection, detail.external_id)
  const setHref = detail.set_slug ? `/${collection}/set/${encodeURIComponent(detail.set_slug)}` : null
  const playerHref = detail.player_name ? `/${collection}/player/${encodeURIComponent(slugifyName(detail.player_name))}` : null
  const teamHref = detail.team_name ? `/${collection}/team/${encodeURIComponent(slugifyName(detail.team_name))}` : null

  // 24h delta from history (latest day vs day prior).
  const dayDelta = fmvDayDelta(history)

  const isAllDay = collection === "nfl-all-day"
  const hasVideo = (collection === "nba-top-shot" || collection === "nfl-all-day") && !!detail.video_url

  // Resilient hero media (Item E, 2026-06-13 audit — parity with the /moment
  // hero). detail.thumbnail_url / video_url are the constructed
  // assets.nbatopshot.com/editions/<set>/<play>/… URLs that 404 on the CDN for
  // many legacy (Series 1-4) Top Shot editions, leaving a blank box. The
  // per-moment media/<nftId>/image form works for any serial of the edition, so
  // we use a representative NFT id (a tracked special-serial holder, else a
  // recent sale) as the primary candidate, then fall back to the stored
  // thumbnail. MomentHeroMedia advances candidates on load error and hides a
  // 404ing video to reveal the image underneath.
  const isTopShotColl = collection === "nba-top-shot"
  const repNftId =
    repSales.find(s => s.nft_id && /^\d+$/.test(s.nft_id))?.nft_id ?? null
  const tsHeroImg =
    isTopShotColl && repNftId
      ? `https://assets.nbatopshot.com/media/${repNftId}/image?width=1080`
      : null
  // Route slow public ipfs.io gateway URLs (UFC, legacy) through our edge-cached
  // same-origin proxy so heavy assets paint reliably instead of timing out.
  const heroImageCandidates = [tsHeroImg, detail.thumbnail_url]
    .map(proxyIpfsUrl)
    .filter((u): u is string => !!u)

  // Team moments carry no player_name — the subject is the team. Fall back to
  // team_name before the raw edition name so the hero/breadcrumb never read
  // blank or generic. Item 3 (2026-06-11). (play_type isn't in get_edition_detail,
  // so the edition title is the team; the moment page adds "<team> <play>".)
  const editionTitle =
    (detail.player_name && detail.player_name.trim())
      ? detail.player_name
      : (detail.team_name && detail.team_name.trim())
        ? detail.team_name
        : (detail.name ?? "Edition")

  // Ask cell (H2/H3): prefer the marketplace low_ask; fall back to the
  // V1-Dapper cross-market ask (populated for ~2.7K All Day editions where
  // badge_editions.low_ask is null). Label is collection-aware.
  const askValue = highOffer?.low_ask ?? fmv?.cross_market_ask ?? null
  const askLabel = ASK_LABEL[collection] ?? "Floor ask"
  // Best-offer cell (H1): only render when there's a real positive offer.
  // edition_offers is Top-Shot-only today, so an em-dash here would be a
  // permanent placeholder on every other collection.
  const hasBestOffer = typeof highOffer?.highest_offer === "number" && highOffer.highest_offer > 0

  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(editionJsonLd(detail as unknown as Record<string, unknown>, collection, highOffer?.low_ask ?? null)) }}
      />
      <Breadcrumbs
        items={[
          { name: "Home", href: "/" },
          { name: collectionDisplayName(collection), href: `/${collection}` },
          ...(setHref && detail.set_name ? [{ name: detail.set_name, href: setHref }] : []),
          { name: editionTitle },
        ]}
      />
      <div style={{ marginBottom: 14 }}>
        <MarketplaceStatusBanner collectionSlug={collection} />
      </div>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="rpc-card" style={{ padding: 18 }}>
        <div className="rpc-entity-hero">
          <div style={{ position: "relative", width: "100%", maxWidth: 320, aspectRatio: "1 / 1", background: "rgba(0,0,0,0.4)", border: "1px solid var(--rpc-border)", borderRadius: 6, overflow: "hidden" }}>
            <MomentHeroMedia
              imageCandidates={heroImageCandidates}
              videoUrl={hasVideo ? detail.video_url : null}
              alt={editionTitle}
              placeholder={
                // Branded placeholder for artless editions (~54% TS thumbnail
                // coverage) so the empty media box reads as intentional, not broken.
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, background: "linear-gradient(135deg, rgba(224,58,47,0.08), rgba(0,0,0,0.45))" }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 28, letterSpacing: "0.08em", color: "var(--rpc-red)", opacity: 0.55 }}>RPC</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.1em" }}>No preview</div>
                </div>
              }
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 36, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", lineHeight: 1.05, textTransform: "uppercase" }}>
              {playerHref ? (
                <Link href={playerHref} style={{ color: "inherit", textDecoration: "none" }}>{detail.player_name ?? detail.name ?? "Edition"}</Link>
              ) : editionTitle}
            </h1>

            {(detail.set_name || setHref) && (
              <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 600, letterSpacing: "0.04em", color: "var(--rpc-text-secondary)" }}>
                {setHref ? (
                  <Link href={setHref} style={{ color: "inherit", textDecoration: "none" }}>{detail.set_name}</Link>
                ) : detail.set_name}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <TierBadge tier={detail.tier} />
              {/* Parallel printing chip (Stage B) — names the subedition this
                  page is, e.g. "Hexwave · /24". Standard shows no chip. */}
              {currentSibling?.subedition_name && (
                <span className="rpc-mono" style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 700, color: "var(--rpc-red)", background: "var(--rpc-red-bg, rgba(224,58,47,0.08))", border: "1px solid var(--rpc-red-border, var(--rpc-border))" }}>
                  {currentSibling.subedition_name}{currentSibling.circulation_count != null ? ` · /${currentSibling.circulation_count}` : ""}
                </span>
              )}
              {detail.series_label && (
                <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>{detail.series_label}</span>
              )}
              {detail.edition_kind && (
                <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>{detail.edition_kind}</span>
              )}
              {detail.circulation_count !== null && (
                <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                  Mint {fmtCount(detail.circulation_count)}
                </span>
              )}
              {detail.team_name && teamHref && (
                <Link href={teamHref} className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-primary)", textDecoration: "none" }}>{detail.team_name}</Link>
              )}
              {isPinnacle && detail.is_chaser && (
                <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 10, letterSpacing: "0.10em", textTransform: "uppercase", color: "#A855F7", background: "rgba(168,85,247,0.10)", border: "1px solid rgba(168,85,247,0.30)" }}>Chaser</span>
              )}
            </div>

            {detail.badges && detail.badges.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {detail.badges.map(b => {
                  const art = badgeArt.get(normalizeBadgeKey(b))
                  if (art) {
                    return (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={b} src={art} alt={b} title={b} width={24} height={24} loading="lazy" style={{ width: 24, height: 24, display: "inline-block", verticalAlign: "middle" }} />
                    )
                  }
                  return (
                    <span key={b} className="rpc-mono" style={{ padding: "2px 6px", border: "1px solid var(--rpc-border)", borderRadius: 3, fontSize: 10, color: "var(--rpc-text-secondary)" }}>{b}</span>
                  )
                })}
              </div>
            )}

            {isPinnacle && detail.live_ask && detail.live_ask.price !== null && (
              <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                Live ask: <span style={{ color: "var(--rpc-text-primary)" }}>{fmtUsd(detail.live_ask.price)}</span>
                {detail.live_ask.source ? <> · {detail.live_ask.source}</> : null}
                {detail.live_ask.updated_at ? <> · {relTime(detail.live_ask.updated_at)}</> : null}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── Parallel tier switcher (top of hero) ─────────────────────────── */}
      {/* Prominent quick-jump between parallel printings of the same play; the
          fuller "Parallel Printings" card grid stays lower on the page. */}
      {hasParallelLadder && (
        <ParallelTierSwitcher collection={collection} siblings={subSiblings} />
      )}

      {/* ── FMV strip ────────────────────────────────────────────────────── */}
      {/* Plain-language valuation answer — crawlable "what is X worth" text,
          featured-snippet eligible; gated to a real FMV. (2026-06-29 SEO) */}
      {fmvAvailable && !marketClosed && (
        <p className="rpc-mono" style={{ margin: "12px 2px 2px", fontSize: 13, lineHeight: 1.65, color: "var(--rpc-text-secondary)" }}>
          <strong style={{ color: "var(--rpc-text-primary)", fontWeight: 700 }}>{editionTitle}{detail.set_name ? ` — ${detail.set_name}` : ""}</strong>{" "}
          is worth ~{fmtUsd(fmv?.fmv_usd ?? null)} (FMV) on {collectionDisplayName(collection)}
          {askValue ? <>, with the lowest ask at {fmtUsd(askValue)}</> : fmv?.floor_price_usd ? <>, with a recent-sale low of {fmtUsd(fmv?.floor_price_usd ?? null)}</> : null}
          {fmv?.sales_count_30d ? <> and {fmtCount(fmv?.sales_count_30d ?? null)} sales in the last 30 days</> : null}
          .{" "}
          <Link href="/legal/fmv-methodology" style={{ color: "var(--rpc-text-muted)", textDecoration: "none" }}>How FMV is calculated →</Link>
        </p>
      )}

      <section style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        <StatCell
          label="Current FMV"
          value={marketClosed ? EM_DASH : fmtUsd(fmv?.fmv_usd ?? null)}
          sub={marketClosed ? undefined : (
            <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
              {/* ConfidencePill removed 2026-07-11 — confidence tiers are
                  build-time signal, not front-end content. FmvBasis keeps the
                  factual basis (sales count / ask-only / no data). */}
              <FmvBasis
                confidence={fmv?.confidence ?? null}
                salesCount30d={fmv?.sales_count_30d ?? null}
                ask={askValue}
              />
              {/* PIN-FMV-REKEY Wave 2: this is the most-liquid render; show the
                  per-render spread when the set-level key fans out. */}
              {isPinnacle &&
                (fmv?.render_count ?? 0) > 1 &&
                fmv?.fmv_min != null &&
                fmv?.fmv_max != null &&
                fmv.fmv_min !== fmv.fmv_max && (
                  <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.04em" }}>
                    range {fmtUsd(fmv.fmv_min)}–{fmtUsd(fmv.fmv_max)} · {fmv.render_count} renders
                  </span>
                )}
            </span>
          )}
        />
        <StatCell
          label="24h Change"
          value={dayDelta === null ? EM_DASH : (
            <span style={{ color: dayDelta >= 0 ? "var(--rpc-success)" : "var(--rpc-danger)" }}>
              {fmtPercent(dayDelta)}
            </span>
          )}
        />
        {/* "Floor" (recent-sale low) removed 2026-07-07 — redundant with the
            Recent Sales table; the FMV-strip prose still cites the recent-sale
            low when no live ask exists. */}
        <StatCell
          label={askLabel}
          value={fmtUsd(askValue)}
          // On a parallel printing the floor ask is suppressed (the edition
          // floor is a different printing's listing) — say so rather than leave
          // a bare em-dash. Per-printing listing keying is a follow-up.
          sub={currentSibling?.subedition_name && askValue == null ? "per-printing floor not yet indexed" : undefined}
        />
        <StatCell
          label="% Listed"
          // em-dash (not "0%") when the collection has no fresh listing source —
          // a "0% listed" off a dead feed would be a lie, not a datapoint.
          value={pctListed == null ? EM_DASH : `${pctListed.toFixed(1)}%`}
          sub={
            pctListed == null
              ? undefined
              : `${fmtCount(bundle.active_listings)} of ${fmtCount(listedSupply)} listed`
          }
        />
        {hasBestOffer && (
          <StatCell
            label={
              currentSibling?.subedition_name && highOffer?.offer_scope === "edition"
                ? "Edition offer"
                : "Best offer"
            }
            value={fmtUsd(highOffer?.highest_offer ?? null)}
            // Scope-aware (2026-07-07): on a parallel printing, prefer THAT
            // printing's own top offer (offer_scope='parallel'); an edition-wide
            // OffersV2 offer (scope='edition') is fillable by ANY printing and
            // only wins when it's the higher of the two.
            sub={
              currentSibling?.subedition_name
                ? `${highOffer?.offer_scope === "edition" ? "fillable by any printing" : `for ${currentSibling.subedition_name}`}${highOffer?.updated_at ? ` · ${relTime(highOffer.updated_at)}` : ""}`
                : (highOffer?.updated_at ? relTime(highOffer.updated_at) : undefined)
            }
          />
        )}
        <StatCell
          label="30d Sales"
          value={fmtCount(fmv?.sales_count_30d ?? null)}
          sub={fmv?.days_since_sale !== null && fmv?.days_since_sale !== undefined ? `${fmv.days_since_sale}d since last` : undefined}
        />
      </section>

      {!fmvAvailable && (
        <div className="rpc-mono" style={{ marginTop: 8, padding: "8px 12px", color: "var(--rpc-text-muted)", fontSize: 11 }}>
          No recent market activity
        </div>
      )}

      {/* ── Outbound marketplace CTA (dapper.market, edition grain) ─────── */}
      {dapperEditionUrl && (
        <div style={{ marginTop: 14 }}>
          <TrackedOutboundLink
            href={dapperEditionUrl}
            payload={{
              surface: "edition",
              destination: "dapper_market_edition",
              editionKey: detail.external_id,
              playerName: detail.player_name,
              setName: detail.set_name,
              tier: detail.tier,
              fmv: fmv?.fmv_usd ?? null,
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "12px 20px",
              background: "transparent",
              color: "var(--rpc-red)",
              border: "1px solid var(--rpc-red)",
              borderRadius: 8,
              textDecoration: "none",
              fontFamily: "var(--font-display)",
              fontWeight: 800,
              fontSize: 14,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            View edition on Dapper ↗
          </TrackedOutboundLink>
        </div>
      )}

      {/* ── Watch this edition (FMV / ask alert) ─────────────────────────── */}
      {/* Pinnacle FMV lives in its own tables the alert dispatcher doesn't read,
          so the watch control is gated to the editions+fmv_snapshots collections. */}
      {!isPinnacle && detail.external_id && (
        <div style={{ marginTop: 14 }}>
          <WatchEditionButton
            editionKey={detail.external_id}
            collectionId={detail.collection_id}
            playerName={detail.player_name}
            setName={detail.set_name}
          />
        </div>
      )}

      {/* ── Parallel Printings (subedition ladder) ──────────────────────── */}
      {/* The headline parallel-conflation feature: Standard + each named
          printing (Jukebox/Hexwave/…) of the SAME setID:playID, each its own
          edition with its own circulation + de-blended per-parallel FMV. */}
      {hasParallelLadder && (
        <Section title="Parallel Printings">
          <div className="rpc-mono" style={{ marginTop: -6, marginBottom: 10, fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>
            Same play, different printings — each is its own edition with its own circulation, serials, and market. The Standard is the base; named parallels are scarcer printings that trade at their own price.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 10 }}>
            {subSiblings.map((s) => {
              const name = s.subedition_name ?? "Standard"
              return (
                <Link
                  key={s.external_id}
                  href={`/${collection}/edition/${encodeURIComponent(s.external_id)}`}
                  className="rpc-card"
                  style={{ padding: 10, textDecoration: "none", color: "inherit", display: "block", border: s.is_self ? "1px solid var(--rpc-red)" : "1px solid var(--rpc-border)" }}
                >
                  <div style={{ aspectRatio: "1 / 1", background: "rgba(0,0,0,0.3)", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
                    {s.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={proxyIpfsUrl(s.thumbnail_url) ?? undefined} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" />
                    ) : null}
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, marginBottom: 4 }}>
                    <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: s.is_self ? "var(--rpc-red)" : "var(--rpc-text-primary)", letterSpacing: "0.04em", lineHeight: 1.2 }}>{name}</span>
                    {s.is_self && <span className="rpc-mono" style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-red)" }}>viewing</span>}
                  </div>
                  <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-primary)" }}>
                    {s.fmv_usd != null ? fmtUsd(s.fmv_usd) : <span style={{ color: "var(--rpc-text-muted)" }}>no FMV</span>}
                    {s.fmv_usd != null && (() => { const b = fmvBasis(s.confidence); return b ? <span title={b.title} style={{ color: "var(--rpc-text-muted)", marginLeft: 4 }}>{b.label}</span> : null })()}
                  </div>
                  <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)", marginTop: 2 }}>
                    {s.circulation_count != null ? `/${fmtCount(s.circulation_count)} mint` : "mint —"}
                  </div>
                </Link>
              )
            })}
          </div>
        </Section>
      )}

      {/* "Media Verified on IPFS" section removed 2026-07-11 — CID plumbing
          stays in the data layer (topshot_ipfs_assets / the market bundle);
          it just isn't front-end content. */}

      {/* ── Featured in Insights (entity → insights internal links) ──────── */}
      {hasInsightLinks && (
        <Section title="Featured in Insights">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {insightLinks.squeeze_pct != null && (
              <Link href="/insights/squeeze" className="rpc-mono" style={INSIGHT_CHIP_STYLE}>
                {Math.round(insightLinks.squeeze_pct)}% squeeze →
              </Link>
            )}
            {insightLinks.deal_pct != null && (
              <Link href="/insights/deals" className="rpc-mono" style={INSIGHT_CHIP_STYLE}>
                {Math.round(insightLinks.deal_pct)}% below FMV →
              </Link>
            )}
            {insightLinks.first_mint_x != null && (
              <Link href="/insights/first-mint" className="rpc-mono" style={INSIGHT_CHIP_STYLE}>
                #1 sold {Number(insightLinks.first_mint_x).toFixed(1)}× the field →
              </Link>
            )}
          </div>
        </Section>
      )}

      {/* ── FMV history chart ────────────────────────────────────────────── */}
      <Section title="FMV History">
        <FmvHistoryChart collectionUrlSlug={collection} routeSlug={detail.route_slug ?? slug} initial={history} />
      </Section>

      {/* ── Heavy bottom sections stream in (recent sales, parallels, packs,
             special serials + owner-username resolution) so they never hold up
             the hero + FMV strip above. ─────────────────────────────────── */}
      <Suspense fallback={<LoadingState lines={4} />}>
        <EditionBottomSections
          detail={detail}
          collection={collection}
          slug={slug}
          isPinnacle={isPinnacle}
          isAllDay={isAllDay}
        />
      </Suspense>
    </div>
  )
}

// Heavy bottom sections — fetched + rendered behind a <Suspense> boundary so the
// hero + FMV strip above paint as soon as get_edition_detail resolves, instead
// of waiting on the full RPC fan-out + the sequential owner-username resolution.
async function EditionBottomSections({
  detail,
  collection,
  slug,
  isPinnacle,
  isAllDay,
}: {
  detail: EditionDetail
  collection: string
  slug: string
  isPinnacle: boolean
  isAllDay: boolean
}) {
  const isTopShot = collection === "nba-top-shot"
  // Each fetch degrades to its empty fallback on a THROW, not just on the
  // supabase-js `{ error }` shape. Under DB contention a heavy RPC (get_edition_
  // recent_sales especially) can reject the promise outright (gateway/statement
  // timeout) rather than returning `{ error }` — the helper's `if (error)` guard
  // never catches that, so the rejection propagated out of Promise.all and threw
  // the ENTIRE bottom section, dropping the "Activity" heading and hard-failing
  // the edition smoke probe even though the page was healthy. Per-fetch .catch
  // keeps the section (and its titled empty-states) rendering when one leg times
  // out, and degrades real users gracefully instead of blanking the block.
  const [salesRes, offersRes, parallels, packs, notableRes, packProvenance, topOwners] = await Promise.all([
    // ⚠ The catch fallbacks carry ok:false. Returning a bare [] here would put the
    // failure back exactly where it was erased before — see fetchSalesResult.
    fetchSalesResult(detail.collection_id, slug, SALES_PAGE_SIZE, 0).catch(() => ({ rows: [] as SaleRow[], ok: false })),
    fetchOffers(detail.id, 50).catch(() => ({ rows: [] as OfferRow[], ok: false })),
    fetchParallels(detail.id).catch(() => [] as ParallelEdition[]),
    fetchPacks(detail.collection_id, slug).catch(() => [] as PackRow[]),
    (isPinnacle
      ? Promise.resolve({ rows: [] as NotableSerialRow[], ok: true })
      : fetchNotableSerials(detail.id)
    ).catch(() => ({ rows: [] as NotableSerialRow[], ok: false })),
    (isTopShot || isAllDay
      ? fetchPackProvenance(detail.id, isAllDay).then((r) => r.data)
      : Promise.resolve(null)
    ).catch(() => null),
    (isTopShot ? fetchTopOwners(detail.id) : Promise.resolve([] as TopOwnerRow[])).catch(() => [] as TopOwnerRow[]),
  ])
  // Rows for rendering; the `ok` halves travel separately to the Activity block
  // so a degraded read can never be published as "No sales yet."
  const sales = salesRes.rows
  const offers = offersRes.rows
  const notableSerials = notableRes.rows

  // Merge the deterministic notable serials (tag + last sale) with the tracked
  // owners (special_serial_holders) by serial — gives one board with tag, last
  // sale, and owner-if-known.
  const ownerBySerial = new Map<number, string>()
  // special_serial_holders is empty platform-wide, so fall back to the holder
  // get_edition_special_serials now resolves from wallet_moments_cache.
  for (const n of notableSerials) {
    if (n.holder_address && !ownerBySerial.has(n.serial)) ownerBySerial.set(n.serial, n.holder_address)
  }
  const sortedNotable = sortNotableSerials(notableSerials)
  // @username for the special-serial owner cells (Item 7) + the Activity tables
  // (P6b). Resolved server-side in ONE query so the Recent Sales / Offers rows
  // paint @names on first render instead of flashing raw 0x… for ~2s while the
  // client hook resolves. The map is a superset, so owner-cell lookups still hit.
  const activityAddrs: string[] = [
    ...sales.flatMap((s) => [s.buyer_address, s.seller_address]),
    ...offers.map((o) => o.buyer_address),
  ].filter((a): a is string => !!a)
  const ownerNames = (await fetchOwnerUsernames([...ownerBySerial.values(), ...activityAddrs, ...topOwners.map((t) => t.owner_address)])).data
  const initialActivityNames: Record<string, string> = Object.fromEntries(ownerNames)

  // H5: only render pack tiles that resolved a real title. Some All Day dist_ids
  // have no matching pack_distributions row, so get_edition_in_packs returns
  // pack_title=NULL and the card would render a bare "Pack" placeholder.
  const namedPacks = packs.filter(p => typeof p.pack_title === "string" && p.pack_title.trim().length > 0)

  return (
    <>
      {/* ── Activity (Sales | Offers toggle) ─────────────────────────────── */}
      {/* Sales reuses the paginated SalesTablePaginated (no regression);
          Offers is the live standing-bid list from get_edition_offers. */}
      <Section title="Activity">
        <EditionActivity
          collectionUrlSlug={collection}
          routeSlug={detail.route_slug ?? slug}
          initialSales={sales}
          initialSalesOffset={sales.length}
          salesPageSize={SALES_PAGE_SIZE}
          isAllDay={isAllDay}
          offers={offers}
          initialNames={initialActivityNames}
          salesOk={salesRes.ok}
          offersOk={offersRes.ok}
        />
      </Section>

      {/* ── Same play in OTHER sets (distinct from the subedition ladder
             above, which is the same set's parallel printings) ──────────── */}
      {parallels.length > 0 && (
        <Section title="Same Play · Other Sets">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
            {parallels.map(p => (
              <Link
                key={p.id}
                href={`/moment/${p.id}`}
                className="rpc-card"
                style={{ padding: 10, textDecoration: "none", color: "inherit", display: "block", border: "1px solid var(--rpc-red)" }}
              >
                <div style={{ aspectRatio: "1 / 1", background: "rgba(0,0,0,0.3)", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
                  {p.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={proxyIpfsUrl(p.thumbnail_url) ?? undefined} alt={p.set_name ?? "parallel"} style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" />
                  ) : null}
                </div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", letterSpacing: "0.04em", lineHeight: 1.2, marginBottom: 4 }}>
                  {p.set_name ?? "—"}
                </div>
                <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)" }}>
                  {(p.tier ?? "").toUpperCase()}
                  {p.circulation_count != null ? ` · ${fmtCount(p.circulation_count)} mint` : ""}
                </div>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {/* ── Found in packs ───────────────────────────────────────────────── */}
      {namedPacks.length > 0 && (
        <Section title="Found in These Packs">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
            {namedPacks.map(p => (
              <Link
                key={p.dist_id}
                href={`/${collection}/pack/dist/${encodeURIComponent(p.dist_id)}`}
                className="rpc-card"
                style={{ padding: 10, textDecoration: "none", color: "inherit", display: "block" }}
              >
                <PackThumb src={p.pack_image_url} alt={p.pack_title ?? "Pack"} />
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", letterSpacing: "0.04em", lineHeight: 1.2, marginBottom: 4 }}>
                  {p.pack_title ?? "Pack"}
                </div>
                <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)" }}>
                  {/* drop_weight 0 = no longer pullable from this pool. Show
                      "exhausted" instead of a broken-looking "0 slots". Only
                      surface depletion when it's actually > 0. */}
                  {p.drop_weight === 0
                    ? "exhausted"
                    : p.drop_weight !== null
                    ? `${p.drop_weight} slot${p.drop_weight === 1 ? "" : "s"}`
                    : "weight unknown"}
                  {p.depletion_pct ? <> · {Math.round(p.depletion_pct)}% depleted</> : null}
                </div>
              </Link>
            ))}
          </div>
        </Section>
      )}

      {/* ── Pack provenance (Top Shot + All Day) ─────────────────────────── */}
      {(isTopShot || isAllDay) && packProvenance && (packProvenance.pack_pulls_observed ?? 0) > 0 && (
        <Section title="Pack Provenance">
          <div className="rpc-mono" style={{ marginTop: -6, marginBottom: 10, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            How much of this edition we&rsquo;ve seen enter the market straight from pack opens.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
            <StatCell
              label="Pack pulls observed"
              value={fmtCount(packProvenance.pack_pulls_observed)}
              sub={packProvenance.distinct_packs != null ? `across ${fmtCount(packProvenance.distinct_packs)} packs` : undefined}
            />
            <StatCell
              label="Pack-distributed share"
              value={packProvenance.observed_pull_share_pct != null ? `~${fmtPercent(packProvenance.observed_pull_share_pct)}` : "—"}
              sub="of circulation, observed (lower bound)"
            />
            <StatCell
              label="First seen pulled"
              value={packProvenance.first_pull_at ? relTime(packProvenance.first_pull_at) : "—"}
              sub={packProvenance.last_pull_at ? `latest ${relTime(packProvenance.last_pull_at)}` : undefined}
            />
          </div>
          <div className="rpc-mono" style={{ marginTop: 10, fontSize: 10, color: "var(--rpc-text-muted)", lineHeight: 1.5 }}>
            Observed since ~{isAllDay ? "Jun" : "Apr"} 2026 and undercounted (not every pulled moment resolves to its edition), so treat
            this as a directional pack-distribution signal — it underestimates older editions.
          </div>
        </Section>
      )}

      {/* ── Special serials (non-Pinnacle) ───────────────── */}
      {!isPinnacle && (
        <Section title="Special Serials">
          <div className="rpc-mono" style={{ marginTop: -6, marginBottom: 10, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            Notable serials — #1, jersey match, and the perfect serial (final mint) — with their last sale and tracked owner where known.
          </div>
          {sortedNotable.length === 0 ? (
            <div style={{ padding: "12px 14px", border: "1px dashed var(--rpc-border)", borderRadius: 6, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
              {sectionEmptyCopy(notableRes.ok, "Special serials", "No notable serials for this edition yet.")}
            </div>
          ) : (
            <div className="rpc-scroll-x" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {sortedNotable.map(r => {
                const owner = ownerBySerial.get(r.serial) ?? null
                const accent = r.tag === "#1" || r.tag === "jersey"
                return (
                  <div key={`${r.tag}-${r.serial}`} style={{ display: "grid", gridTemplateColumns: "minmax(0,140px) 70px 1fr 140px", gap: 12, alignItems: "center", padding: "8px 10px", border: "1px solid var(--rpc-border)", borderRadius: 4, minWidth: 460 }}>
                    <span
                      className="rpc-mono"
                      style={{
                        justifySelf: "start",
                        display: "inline-flex", alignItems: "center", gap: 4,
                        padding: "2px 8px",
                        borderRadius: 4,
                        fontSize: 10,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        fontWeight: 700,
                        color: accent ? "var(--rpc-red)" : "var(--rpc-text-secondary)",
                        background: accent ? "var(--rpc-red-bg, rgba(224,58,47,0.08))" : "rgba(255,255,255,0.04)",
                        border: `1px solid ${accent ? "var(--rpc-red-border, var(--rpc-border))" : "var(--rpc-border)"}`,
                      }}
                    >
                      <SpecialSerialGlyph tag={r.tag} size={11} collection={collection} />
                      {notableTagLabel(r.tag)}
                    </span>
                    <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>#{r.serial}</span>
                    <span className="rpc-mono" style={{ fontSize: 11, color: r.last_sale_usd != null ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)" }}>
                      {r.last_sale_usd != null ? `${fmtUsd(r.last_sale_usd)} · ${relTime(r.last_sold_at)}` : "never sold"}
                    </span>
                    {owner ? <WalletLink address={owner} name={ownerNames.get(owner.toLowerCase()) ?? null} /> : <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", textAlign: "right" }}>owner —</span>}
                  </div>
                )
              })}
            </div>
          )}
          {collection === "nba-top-shot" && detail.player_name ? (
            <div style={{ marginTop: 10 }}>
              <Link
                href={`/special-serial-owners?player=${encodeURIComponent(detail.player_name)}`}
                className="rpc-mono"
                style={{ fontSize: 11, letterSpacing: "0.04em", color: "var(--rpc-red)", textDecoration: "none" }}
              >
                See who holds {detail.player_name}&rsquo;s special serials →
              </Link>
            </div>
          ) : null}
        </Section>
      )}

      {/* ── Top Owners (Top Shot current-season ownership index) ── */}
      {isTopShot && topOwners.length > 0 && (
        <Section title="Top Owners">
          <div className="rpc-mono" style={{ marginTop: -6, marginBottom: 10, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            {/* `total_moments` is how many of this edition's moments RPC has
                INDEXED as held — not the mint count (this header used to call
                them "minted moments", which read as the supply figure and
                contradicted the Mint chip above). Same honest lower-bound
                framing as PACK PROVENANCE on this page. */}
            Biggest holders of this edition — {fmtCount(topOwners[0].total_holders)} collectors hold{" "}
            {detail.circulation_count != null
              ? <>{fmtCount(topOwners[0].total_moments)} of its {fmtCount(detail.circulation_count)} moments</>
              : <>{fmtCount(topOwners[0].total_moments)} of its moments</>}{" "}
            (indexed holdings, a lower bound; parent + child Dapper wallets combined).
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {topOwners.map((t, i) => (
              <div key={t.owner_address} style={{ display: "grid", gridTemplateColumns: "26px 1fr 96px", gap: 12, alignItems: "center", padding: "8px 10px", border: "1px solid var(--rpc-border)", borderRadius: 4 }}>
                <span className="rpc-mono" style={{ fontSize: 12, fontWeight: 700, color: i === 0 ? "var(--rpc-red)" : "var(--rpc-text-muted)" }}>{i + 1}</span>
                <WalletLink address={t.owner_address} name={ownerNames.get(t.owner_address.toLowerCase()) ?? null} />
                <span className="rpc-mono" style={{ fontSize: 12, textAlign: "right", color: "var(--rpc-text-primary)", fontWeight: 700 }}>
                  {fmtCount(t.moment_count)}<span style={{ color: "var(--rpc-text-muted)", fontWeight: 400 }}> owned</span>
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

// Rendered when get_edition_detail could not be READ — distinct from an edition
// that does not exist (that still 404s). Reports our failure and makes no claim
// about the edition's market.
function EditionUnavailable({ collection, slug }: { collection: string; slug: string }) {
  return (
    <main style={{ minHeight: "60vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", gap: 16 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        Moment unavailable
      </div>
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "clamp(26px, 5vw, 42px)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0, textAlign: "center" }}>
        Couldn&rsquo;t load this moment
      </h1>
      <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 520, textAlign: "center", margin: 0, lineHeight: 1.5 }}>
        The data didn&rsquo;t come back in time, so nothing is shown rather than a partial view.
        This is a problem on our side &mdash; it does not mean the moment is gone or unpriced. Reloading often works.
      </p>
      <a
        href={`/${collection}/collection`}
        style={{ marginTop: 8, padding: "10px 18px", border: "1px solid var(--rpc-red-border)", color: "var(--rpc-red)", background: "transparent", fontFamily: "var(--font-mono)", letterSpacing: "0.2em", textTransform: "uppercase", fontSize: 12, textDecoration: "none" }}
      >
        Browse collection
      </a>
    </main>
  )
}
