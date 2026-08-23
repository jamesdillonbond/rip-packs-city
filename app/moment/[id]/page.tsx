// app/moment/[id]/page.tsx
//
// Public, server-rendered edition / moment detail page. Resolves [id] as
// flow nft_id (numeric), moment uuid (serial-specific), or edition uuid
// (aggregate). Backed by the SECDEF RPC public.get_moment_detail, with
// parallel extras: get_edition_high_offer, get_edition_parallels,
// get_edition_badges_unified, and a direct special_serial_holders lookup.
//
// Targets:
//   - Trophy Slab QR codes (already shipping)
//   - Insider Signals card click-through
//   - Fast Break lineup rows (Phase 2 wallet-aware)
//   - SEO: "<player> <set> #<serial>" long-tail queries
//
// Phase 2 (2026-05-26) updates:
//   - Replaced Marketplace column with Buyer + Seller in Recent Activity.
//   - Added Top Shot Best Offer cell (next to Top Shot Ask).
//   - Added Badges row (sourced from get_edition_badges_unified).
//   - Replaced inline serial===1 check with a special-serial pills row
//     keyed by (edition_id, serial_number) when kind='moment'.
//   - Added a Parallels section (same player, same play_id_onchain across
//     different sets) above Similar Editions.
//   - Moved the 6-cell info bar from the footer into the body, between
//     the hero and Recent Activity, with linked Team.

import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import Link from "next/link"
// The data-access layer moved to lib/ (2026-08-13) so it lands inside the primary
// coverage gate — `app/**/page.tsx` is measured by neither — and so a failed read
// can be told apart from an absent moment. Before that, an RPC failure answered
// notFound() on the platform's most-shared URL. See the module header.
import {
  fetchMomentDetail,
  fetchHighOffer,
  fetchMomentBestOffer,
  fetchParallels,
  fetchSubeditionSiblings,
  fetchBadges,
  fetchSpecialSerialsForSerial,
  fetchEditionNotableSerials,
  fetchActiveListingAsk,
  type HighOffer,
  type ParallelEdition,
  type EditionBadge,
  type SpecialSerialRow,
  type NotableSerialRow,
  type MomentBestOffer,
  type SubeditionSibling,
} from "@/lib/moment-detail/fetchers"
import { summarizeDegraded, boardStatus } from "@/lib/insights/board-status"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { seriesDisplay } from "@/lib/series-label"
import { fmvBasis } from "@/lib/fmv-basis"
import { momentSubject, notableTagLabel, specialSerialLabel } from "@/lib/moment-labels"
import { isMarketClosed } from "@/lib/market-closed"
import {
  decodeMomentId,
  fmtUsd,
  fmtRelDate,
  fmtAbsDate,
  tierColorVar,
  collectionLabel,
  urlSlugForCollection,
  slugifyTeam,
} from "@/lib/moment-detail-format"
import { resolveUsernames } from "@/lib/flowty-username"
import SpecialSerialGlyph from "@/components/SpecialSerialGlyph"
import { marketplaceMomentUrl, dapperMarketMomentUrl, dapperMarketEditionUrl } from "@/lib/collections"
import TrackedOutboundLink from "@/components/TrackedOutboundLink"
import SiteFooter from "@/components/SiteFooter"
import MomentHeroMedia from "@/components/MomentHeroMedia"
import { proxyIpfsUrl } from "@/lib/ipfs-media"
import { joinMetaParts, metaField } from "@/lib/format"
import WatchEditionButton from "@/components/alerts/WatchEditionButton"
import { normalizeBadgeKey } from "@/lib/badges/normalize"
import {
  deriveSerialBadges,
  showPriceBand as computeShowPriceBand,
  momentCanonicalPath,
  buildHeroImageCandidates,
  buildMomentProductLd,
} from "@/lib/moment-detail-seo"
import { fetchBadgeArt } from "@/lib/badges/server-art"
import ParallelTierSwitcher from "@/components/entity/ParallelTierSwitcher"
import { OG_INHERITED } from "@/lib/seo"

// Display label for the native marketplace per URL slug. Only collections with
// a marketplaceMomentUrl template can produce a valid deep link.
const MARKETPLACE_LABEL: Record<string, string> = {
  "nba-top-shot": "Top Shot",
  "nfl-all-day": "NFL All Day",
  "laliga-golazos": "LaLiga Golazos",
  "disney-pinnacle": "Pinnacle",
}

// Collection-aware label for the lowest-ask cell — the value source is not
// always Top Shot, so "Top Shot ask" must not show on a non-Top-Shot page.
const ASK_LABEL: Record<string, string> = {
  "nba-top-shot": "Top Shot ask",
  "nfl-all-day": "All Day ask",
  "laliga-golazos": "Golazos ask",
  "disney-pinnacle": "Pinnacle ask",
  // Both UFC URL forms — canonical `ufc` and the `ufc-strike` alias — must map,
  // or the ask cell falls through to the generic "Floor ask" (see the note on
  // the same map in lib/edition-detail-format.ts).
  "ufc": "UFC ask",
  "ufc-strike": "UFC ask",
}

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// ── RPC payload shapes ─────────────────────────────────────────────────────

type Confidence = "HIGH" | "MEDIUM" | "LOW" | "NO_DATA" | "ASK_ONLY" | "SALES_ONLY" | "STALE" | null

// db/url collection slug -> UUID, for the "watch this edition" alert (the
// editions+fmv_snapshots collections only; Pinnacle FMV lives elsewhere).
const WATCH_COLLECTION_ID: Record<string, string> = {
  nba_top_shot: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  "nba-top-shot": "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  nfl_all_day: "dee28451-5d62-409e-a1ad-a83f763ac070",
  "nfl-all-day": "dee28451-5d62-409e-a1ad-a83f763ac070",
  laliga_golazos: "06248cc4-b85f-47cd-af67-1855d14acd75",
  "laliga-golazos": "06248cc4-b85f-47cd-af67-1855d14acd75",
  ufc_strike: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
  "ufc-strike": "9b4824a8-736d-4a96-b450-8dcc0c46b023",
}

interface MomentResolved {
  kind: "moment" | "edition" | "pinnacle_edition"
  moment_id: string | null
  edition_id: string
  serial_number: number | null
  collection_id: string
  collection_slug: string
  pinnacle_edition_id?: string | null
}

// Wave 2 (PIN-FMV-REKEY): a Pinnacle legacy edition_key maps to MANY renders.
// get_moment_detail returns the render-true set so /moment/<legacy-key> can
// disambiguate to the per-pin /pinnacle/moment/<render_id> pages instead of
// showing one arbitrary character's set-level blend.
interface PinnacleRender {
  render_id: string
  character_name: string | null
  set_name: string | null
  variant: string | null
  total_minted: number | null
  fmv_usd: number | null
  fmv_confidence: string | null
  floor_ask: number | null
  thumbnail_url: string | null
}

interface MomentEdition {
  id: string
  external_id: string | null
  name: string | null
  tier: string | null
  series: number | null
  player_name: string | null
  team_name: string | null
  set_name: string | null
  set_id_onchain: number | null
  play_id_onchain: number | null
  play_type: string | null
  play_category: string | null
  game_date: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  video_url: string | null
  collection_slug: string | null
}

interface MomentFmv {
  fmv_usd: number | null
  floor_price_usd: number | null
  wap_usd: number | null
  confidence: Confidence
  sales_count_7d: number | null
  sales_count_30d: number | null
  days_since_sale: number | null
  computed_at: string | null
  algo_version: string | null
  top_shot_ask: number | null
  flowty_ask: number | null
  cross_market_ask: number | null
}

interface MomentSerialSpecific {
  serial_number: number | null
  nft_id: string | null
  owner_address: string | null
  is_listed: boolean | null
  list_price: number | null
  listed_at: string | null
  last_sale: {
    price_usd: number | null
    sold_at: string | null
    buyer_address: string | null
    seller_address: string | null
    marketplace: string | null
  } | null
}

interface RecentSale {
  serial_number: number | null
  price_usd: number | null
  sold_at: string | null
  marketplace: string | null
  buyer_address: string | null
  seller_address: string | null
  // Top Shot: which printing (Standard / Hexwave / ...) the sale belongs to.
  parallel?: string | null
}

interface SimilarEdition {
  id: string
  player_name: string | null
  set_name: string | null
  tier: string | null
  series?: number | null
  circulation_count: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
}

// Phase 2 serial-adjusted FMV: additive #1/perfect-mint premium estimate.
// Present only for HIGH/MEDIUM-base #1 or perfect-mint serials; NULL otherwise.
// A guide (median abs error ~45% on #1s), never a quote. Floored at edition FMV.
interface SerialFmv {
  estimate_usd: number
  multiplier: number
  serial_bucket: "first" | "perfect"
  circ_band: string
  basis: "tier_circ" | "aggregate"
  sample_size: number
  label: string
}

// Cleaned 30d price band (DISPLAY-ONLY, 2026-06-15). p10/p90 of the last 30d of
// sales after the fmv-recalc gate's own cleaning (drop < $0.50 dust, drop
// > 5x survivor-median outliers). Present only for LOW/MEDIUM editions with
// >= 10 stored 30d sales and >= 5 cleaned survivors — the high-volume cohort
// whose bare "LOW" badge reads as RPC being wrong. Turns "LOW" into an honest
// "actively traded, wide range" signal. Consistent by construction with the
// confidence label; never touches the FMV value or the gate. NULL otherwise.
interface PriceBand30d {
  low: number | null
  high: number | null
  n: number | null
}

interface MomentDetail {
  ok: boolean
  error?: string
  input?: string
  resolved?: MomentResolved
  edition?: MomentEdition
  fmv?: MomentFmv
  serial_specific?: MomentSerialSpecific | null
  serial_fmv?: SerialFmv | null
  price_band_30d?: PriceBand30d | null
  recent_sales?: RecentSale[]
  similar_editions?: SimilarEdition[]
  renders?: PinnacleRender[]
}


// ── Fetch helpers ──────────────────────────────────────────────────────────

// Next delivers the [id] route segment URL-encoded (e.g. a Pinnacle legacy key
// `STAR-OEV1-SWHM:Digital Display:1` arrives as `...%3ADigital%20Display%3A1`).
// resolve_moment_id matches the decoded colon form (pe.id), so decode at the
// lambda boundary — same footgun fixed on the edition pages (bf3f4f6). No-op for
// numeric nft_ids and uuids. (decodeMomentId extracted to @/lib/moment-detail-format.)


// notableTagLabel extracted to @/lib/moment-labels (imported below).


// ── Formatters ─────────────────────────────────────────────────────────────
// fmtUsd / fmtRelDate / fmtAbsDate / tierColorVar / collectionLabel /
// urlSlugForCollection / slugifyTeam extracted to @/lib/moment-detail-format
// (imported above) so their null/branch logic is unit-tested.
// SERIES_DISPLAY / seriesDisplay extracted to @/lib/series-label (imported below).

// Subject label for a moment. Player moments → player name. Team moments (no
// player_name — WNBA Skyline, Squad Goals, Fit Check, Dynamic Duos, …) → the
// team plus its play type, mirroring Dapper Market ("Portland Fire Reel"). Item
// 3 (2026-06-11). Falls back to the raw edition name, then "Moment", so an inert
// stub never renders blank.
// momentSubject / specialSerialLabel extracted to @/lib/moment-labels (imported below).

// ── Metadata (SEO) ─────────────────────────────────────────────────────────

export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> }
): Promise<Metadata> {
  const { id: rawId } = await params
  const id = decodeMomentId(rawId)
  const { data: raw, ok: detailOk } = await fetchMomentDetail(id)
  const detail = raw as MomentDetail | null
  if (!detail || detail.ok === false || !detail.edition) {
    // Only an ANSWERED read may claim the moment is not in the index. A failed
    // one says so instead — the title is what a crawler and a shared link read.
    return detailOk
      ? {
          title: "Moment Not Found — Rip Packs City",
          description: "This moment isn't in our index yet.",
        }
      : {
          title: "Moment Unavailable — Rip Packs City",
          description: "We couldn't load this moment right now. Try again in a moment.",
          robots: { index: false, follow: true },
        }
  }
  // Pinnacle render disambiguation (Wave 2): a legacy edition_key maps to many
  // renders — noindex,follow (mirrors /pinnacle/moment/<legacy-key>).
  const pinRenders =
    detail.resolved?.kind === "pinnacle_edition" ? (detail.renders ?? []) : []
  if (pinRenders.length > 1) {
    return {
      title: { absolute: `Pick a pin — ${pinRenders.length} editions | Rip Packs City` },
      description: `${pinRenders.length} distinct Disney Pinnacle renders share this set-level key. Pick the exact character.`,
      robots: { index: false, follow: true },
    }
  }
  const e = detail.edition
  const serial = detail.resolved?.serial_number
  const mint = e.circulation_count ?? 0
  const tier = metaField(e.tier)?.toUpperCase() ?? null
  const player = momentSubject(e.player_name, e.team_name, e.play_type, e.name)
  const setName = metaField(e.set_name)
  // Never advertise a 30-day sales count when the last sale is older than 30
  // days (self-contradiction — systemic on the closed UFC market, and a small
  // self-correcting tail elsewhere). Mirrors the fmv_snapshots zero-stale guard.
  const sales30 =
    (detail.fmv?.days_since_sale ?? 0) > 30 ? 0 : (detail.fmv?.sales_count_30d ?? 0)
  const serialSuffix = serial ? ` #${serial}/${mint}` : (mint ? ` (${mint} circulation)` : "")
  // joinMetaParts, not raw interpolation (2026-07-25): a null `set_name` or
  // `tier` previously collapsed to "" and left "Player #3/60 ·  · " in the title
  // and a double space ("for Player  #3/60 on …") in the description, and an
  // untrimmed value leaked whitespace ahead of the " · " separator.
  const title = `${joinMetaParts([`${player}${serialSuffix}`, setName, tier], " · ")} | Rip Packs City`
  const subject = joinMetaParts([player, setName], " ")
  const description = `Live FMV, sale history, and market data for ${subject}${serialSuffix} on ${collectionLabel(e.collection_slug).toLowerCase().replace(/^\w/, c => c.toUpperCase())}. ${sales30 ? `${sales30} sales in last 30 days. ` : ""}Powered by Rip Packs City.`
  const ogImage = `/api/og/moment/${encodeURIComponent(id)}`
  // Canonical consolidation (SEO, 2026-06-05): /moment/<id> shows the same
  // moment as the richer, better-linked /<collection>/edition/<slug>. Point the
  // canonical at the edition page so the two URLs don't compete for the same
  // query. The edition route slug is the edition's external_id for the standard
  // collections (get_edition_detail resolves on external_id OR id; its own
  // route_slug = COALESCE(external_id, id)), and the edition uuid (pe.id) for
  // Pinnacle. Fall back to the self-canonical if we can't resolve a url slug or
  // route key (never emit a broken canonical).
  const canonicalPath = momentCanonicalPath({
    collectionSlug: e.collection_slug,
    editionId: e.id,
    externalId: e.external_id,
    momentUrlId: id,
  })
  // Describes what is IN the card, for screen readers and the platforms that
  // surface alt text. Deliberately free of prices: the card withholds figures
  // on a failed read, and this string is built before we know whether the
  // card's own reads succeeded.
  const imageAlt = `${subject}${serialSuffix} on Rip Packs City`

  return {
    // `absolute` skips the site-wide "%s | Rip Packs City" title.template so the
    // document <title> isn't double-suffixed (the title string already carries
    // the brand). OG/Twitter keep the full branded `title` string below.
    title: { absolute: title },
    description,
    alternates: { canonical: canonicalPath },
    openGraph: {
      ...OG_INHERITED,
      title,
      description,
      // ⚠ WIDTH/HEIGHT/ALT ARE NOT DECORATION ON THIS PAGE. /moment/<id> is the
      // most-shared URL RPC has — it is where every link posted into a Discord
      // or a DM lands — and the image was a bare relative string. Without
      // explicit dimensions a crawler must fetch and measure the PNG before it
      // will commit to a large card, and several will fall back to a small
      // thumbnail rather than wait. Stated here, they are free.
      images: [{ url: ogImage, width: 1200, height: 630, alt: imageAlt }],
      url: canonicalPath,
      siteName: "Rip Packs City",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      // Restated because Next REPLACES `twitter` wholesale when a route
      // redefines it rather than merging — the root's creator handle from
      // lib/seo.ts does not survive otherwise.
      site: "@RipPacksCity",
      creator: "@RipPacksCity",
      title,
      description,
      images: [{ url: ogImage, alt: imageAlt }],
    },
  }
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function MomentPage(
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params
  const id = decodeMomentId(rawId)
  const { data: raw, ok: detailOk } = await fetchMomentDetail(id)
  const detail = raw as MomentDetail | null
  // ⚠ A FAILED read must never become a 404. This page is the platform's most
  // shared URL; answering "no such moment" because the RPC timed out tells a
  // collector their moment does not exist and hands a crawler a hard 404 for a
  // real, linked page. `detail.ok === false` is the RPC's own verdict — that IS
  // an answer and still 404s. See lib/moment-detail/fetchers.ts on the two `ok`s.
  if (!detailOk) return <MomentUnavailableCard id={id} />
  if (!detail || detail.ok === false) {
    notFound()
  }

  // Pinnacle render disambiguation (Wave 2, PIN-FMV-REKEY). One legacy
  // edition_key maps to many renders, so a single set-level page would show one
  // arbitrary character's blended price. Single render → link straight through
  // to its per-pin page; multiple → render a "Pick a pin" list. Empty (numeric
  // legacy id with no render mapping) falls through to the set-level view.
  if (detail.resolved?.kind === "pinnacle_edition") {
    const renders = detail.renders ?? []
    if (renders.length === 1) {
      redirect(`/pinnacle/moment/${encodeURIComponent(renders[0].render_id)}`)
    }
    if (renders.length > 1) {
      return <PinnacleDisambiguation renders={renders} />
    }
  }

  if (!detail.edition) {
    notFound()
  }

  const e = detail.edition
  const f = detail.fmv
  const r = detail.resolved
  const ss = detail.serial_specific
  const recentSales = detail.recent_sales ?? []
  const similar = detail.similar_editions ?? []

  // Phase 2 serial-adjusted FMV. This is PUBLIC exposure, so it stays behind a
  // flag until the LiveToken cross-check (the mandatory pricing-change gate) is
  // run. Owner-only surfaces (trophy slabs) render it immediately, unflagged.
  // 2026-06-15: LiveToken cross-check PASSED — SERIAL_FMV_PUBLIC=true on Prod,
  // so the public #1/perfect premium line is now live on this page.
  const serialFmvPublicEnabled = process.env.SERIAL_FMV_PUBLIC === "true"
  const sfmv = serialFmvPublicEnabled ? detail.serial_fmv ?? null : null

  // Cleaned 30d price band beside the confidence badge (DISPLAY-ONLY). The RPC
  // already gates the band to the high-volume LOW/MEDIUM cohort and only returns
  // one with >= 5 cleaned survivors; render only when both ends resolved and the
  // range is non-degenerate, so a bare "LOW" reads as "actively traded, wide
  // range" rather than "no data". Never touches the FMV value or the gate.
  // Ask-derived marker for the hero FMV. Null for every sale-derived price, so
  // the common case renders exactly as before. See lib/fmv-basis.ts.
  const askBasis = f?.fmv_usd != null ? fmvBasis(f.confidence) : null

  const band = detail.price_band_30d ?? null
  const showPriceBand = computeShowPriceBand(f, band)

  const serial = r?.serial_number ?? ss?.serial_number ?? null
  const mint = e.circulation_count ?? 0
  const tier = (e.tier ?? "").toUpperCase()
  // Item 3: player moment → player; team moment → "<team> <play>"; never blank.
  const subject = momentSubject(e.player_name, e.team_name, e.play_type, e.name)
  const tierColor = tierColorVar(e.tier)
  const collectionSlugUrl = urlSlugForCollection(e.collection_slug)
  const collectionDisplay = collectionLabel(e.collection_slug)

  // Market-closure honesty (2026-08-04). A collection whose Flow market has
  // closed (UFC) can never publish a *current* FMV again — fmv-recalc Step 6
  // carries the last value forward with a fresh computed_at, so the number below
  // is frozen at the last trading day yet reads as live. Suppress the hero dollar
  // for closed markets; the closure note lower on the page explains it, and the
  // historical Avg Sales Price / Recent activity (past-tense, dated) stay.
  const marketClosed = isMarketClosed(collectionSlugUrl)
  const showHeroFmv = f?.fmv_usd != null && !marketClosed
  // Never render a "N sales / 30d" claim when the last sale is older than 30
  // days — the same self-contradiction the fmv_snapshots zero-stale guard fixes
  // in the data layer, gated here too so any not-yet-recomputed row is honest.
  const showSalesCount = (f?.days_since_sale ?? 0) <= 30

  // Outbound marketplace deep link. marketplaceMomentUrl() builds a
  // SPECIFIC-moment URL (e.g. nbatopshot.com/moment/<nftId>), so it's only
  // valid when we have a concrete on-chain NFT id — i.e. a serial-specific
  // page (kind='moment'). Edition-level pages have no single moment to link
  // to, so we don't fabricate a URL for them. UFC Strike has no template, so
  // marketplaceMomentUrl returns null there and the CTA is omitted.
  const marketplaceNftId = ss?.nft_id ?? (r?.kind === "moment" ? r?.moment_id ?? null : null)
  const marketplaceUrl =
    collectionSlugUrl && marketplaceNftId
      ? marketplaceMomentUrl(collectionSlugUrl, marketplaceNftId)
      : null
  const marketplaceName = collectionSlugUrl ? MARKETPLACE_LABEL[collectionSlugUrl] ?? null : null
  // Second-marketplace (dapper.market) deep link — same serial-specific NFT id.
  // Returns null for non-dapper collections (Pinnacle/UFC) and edition-level
  // pages (no concrete moment id), so the CTA self-hides.
  const dapperUrl =
    collectionSlugUrl && marketplaceNftId
      ? dapperMarketMomentUrl(collectionSlugUrl, marketplaceNftId)
      : null

  // EDITION-grain fallback. On an edition-level page (kind !== 'moment') there
  // is no single NFT id, so both CTAs above are null by design and the page
  // ends up with no outbound link at all. dapper.market publishes a real
  // per-EDITION page keyed by the same editions.external_id we already hold, so
  // those pages get one honest link instead of none. Null for every collection
  // without a VERIFIED edition-URL shape (see dapperMarketEditionUrl), and
  // suppressed on a closed market so a dead venue never gets a buy CTA.
  const dapperEditionUrl =
    !dapperUrl && collectionSlugUrl && !marketClosed
      ? dapperMarketEditionUrl(collectionSlugUrl, e.external_id)
      : null

  // Item 1 (2026-06-13): resilient hero image. The constructed
  // editions.thumbnail_url / video_url 404 on the CDN for many legacy (Series
  // 1-4) Top Shot editions, leaving a blank hero on ~30% of premium moment
  // pages. The per-moment `media/<momentId>/image` form works on all of them
  // (same source the trophy slabs use). Prefer it for Top Shot moment pages,
  // then fall back to the stored edition thumbnail; other collections keep their
  // working stored thumbnail. MomentHeroMedia advances through the candidates on
  // load error and hides a 404ing video to reveal the image underneath.
  const isTopShotColl = e.collection_slug === "nba_top_shot" || e.collection_slug === "nba-top-shot"
  // Resilient hero image candidates (see lib/moment-detail-seo). Prefers the
  // per-moment media URL for Top Shot, then the stored thumbnail; slow public
  // ipfs.io gateway URLs are routed through our edge-cached same-origin proxy.
  const heroImageCandidates = buildHeroImageCandidates({
    collectionSlug: e.collection_slug,
    marketplaceNftId,
    thumbnailUrl: e.thumbnail_url,
  })

  // Parallel extras — all SECDEF RPCs, independent, fan out in one pass.
  const [highOfferRes, parallelsRes, badgesRes, specialSerialsRes, momentBestOfferRes, notableSerialsRes, activeListingAskRes, subSiblingsRes] = await Promise.all([
    fetchHighOffer(e.id),
    fetchParallels(e.id),
    fetchBadges(e.id),
    r?.kind === "moment" && serial != null
      ? fetchSpecialSerialsForSerial(e.id, serial)
      : Promise.resolve({ rows: [] as SpecialSerialRow[], ok: true }),
    // Item 1: serial-aware best offer only for a concrete serial (kind='moment').
    // Edition-level pages stay edition-grain (highOffer below).
    r?.kind === "moment" && serial != null
      ? fetchMomentBestOffer(e.id, serial)
      : Promise.resolve({ data: null as MomentBestOffer | null, ok: true }),
    // Item 2 (2026-06-13): edition-wide notable serials + holders for the
    // "Special serials" section.
    fetchEditionNotableSerials(e.id),
    // Bug 13 (2026-07-03): live "Listed" ask for THIS serial from
    // cached_listings_v2, keyed on its concrete nft_id (kind='moment' only).
    r?.kind === "moment" && ss?.nft_id
      ? fetchActiveListingAsk(ss.nft_id, r?.collection_id ?? null)
      : Promise.resolve({ data: null as number | null, ok: true }),
    // Parallel-printing ladder for the switcher (Top Shot editions only —
    // the setID:playID[::subID] external_id form is what the RPC keys on).
    isTopShotColl && e.external_id
      ? fetchSubeditionSiblings(e.external_id)
      : Promise.resolve({ rows: [] as SubeditionSibling[], ok: true }),
  ])
  const highOffer = highOfferRes.data
  const parallels = parallelsRes.rows
  const badges = badgesRes.rows
  const specialSerials = specialSerialsRes.rows
  const momentBestOffer = momentBestOfferRes.data
  const notableSerials = notableSerialsRes.rows
  const activeListingAsk = activeListingAskRes.data
  const subSiblings = subSiblingsRes.rows
  // Every one of these panels SELF-HIDES when its data is absent, so a failed
  // read is indistinguishable from "this moment has no badges / no parallels /
  // no offers" — the reader sees a shorter page and no reason for it. The notice
  // is the only thing separating those. A panel that does not APPLY (the
  // Top-Shot-only subedition ladder, the edition-level pages that skip the
  // serial-grain reads) reports ok:true and never fires this.
  const auxDegraded = summarizeDegraded([
    boardStatus("Offers", highOfferRes.ok && momentBestOfferRes.ok),
    boardStatus("Parallels", parallelsRes.ok),
    boardStatus("Badges", badgesRes.ok),
    boardStatus("Special serials", specialSerialsRes.ok && notableSerialsRes.ok),
    boardStatus("Live ask", activeListingAskRes.ok),
    boardStatus("Printing ladder", subSiblingsRes.ok),
  ])


  // Resolve owner/buyer/seller + special-serial holder addresses to Top Shot
  // @handles once, server-side (Item 3, 2026-06-09; extended 2026-06-13 to
  // include notable-serial holders). resolveUsernames reads the broadened
  // analytics_resolve_usernames RPC (wallet_usernames → seeded → saved).
  const ownerNameMap = await resolveUsernames(
    [
      ss?.owner_address ?? null,
      ...recentSales.flatMap((s) => [s.buyer_address, s.seller_address]),
      ...notableSerials.map((n) => n.holder_address),
    ].filter((a): a is string => !!a),
  )
  const nameFor = (addr: string | null | undefined) =>
    addr ? ownerNameMap.get(addr.toLowerCase()) ?? null : null

  // Best-offer cell source: for a concrete serial, show the eligible-max
  // (edition ∪ this-serial); for an edition-level page, the edition-grain value.
  const isSerialMoment = r?.kind === "moment" && serial != null
  const bestOfferAmount = isSerialMoment
    ? (momentBestOffer?.best_offer ?? null)
    : (highOffer?.highest_offer ?? null)
  const bestOfferUpdatedAt = isSerialMoment
    ? (momentBestOffer?.updated_at ?? null)
    : (highOffer?.updated_at ?? null)
  const bestOfferGrain = isSerialMoment ? (momentBestOffer?.grain ?? null) : "edition"
  const hasBestOffer = bestOfferAmount != null && bestOfferAmount > 0

  // Item 3b — deterministic hero badges for the current serial that the
  // special_serial_holders sweep may not have populated (#1 + the perfect
  // serial #N/N). Only #1 / Jersey Match / Perfect Serial count as special
  // serials (Trevor 2026-06-13). Deduped against the labels already shown from
  // special_serial_holders so the hero never doubles up.
  const derivedSerialBadges: string[] =
    r?.kind === "moment" && serial != null
      ? deriveSerialBadges(
          serial,
          mint,
          new Set(specialSerials.map((s) => specialSerialLabel(s.badge_type))),
        )
      : []

  // Real badge artwork (the SVGs Trevor wants in place of ALL-CAPS text pills),
  // keyed by normalized title. Only the official badges with art resolve; the
  // rest render as the existing pill. (2026-06-15)
  const badgeArt = await fetchBadgeArt(badges.map((b) => b.title), r?.collection_id ?? null)

  const teamHref =
    collectionSlugUrl && e.team_name
      ? `/${collectionSlugUrl}/team/${encodeURIComponent(slugifyTeam(e.team_name))}`
      : null

  // Schema.org Product JSON-LD — gives crawlers a structured snapshot of the
  // moment as a saleable item with current FMV as the price hint.
  // Availability reflects real listing state: a live ask (serial-specific
  // is_listed=true with a list_price, or an edition-level top_shot_ask) is
  // InStock; otherwise OutOfStock. FMV alone is not a listing (Moment audit B7).
  // A STALE FMV is an unreliable price hint — omit the Offer entirely rather
  // than let Google index a wrong price (a wrong indexed price is worse than
  // none). Non-stale FMV / floor still feeds the Offer as before.
  const productLd = buildMomentProductLd({
    subject,
    serial,
    mint,
    setName: e.set_name,
    collectionDisplay,
    thumbnailUrl: e.thumbnail_url,
    sku: r?.moment_id ?? r?.edition_id,
    fmvConfidence: f?.confidence,
    fmvUsd: f?.fmv_usd,
    floorPriceUsd: f?.floor_price_usd,
    topShotAsk: f?.top_shot_ask,
    isListed: ss?.is_listed,
    listPrice: ss?.list_price,
  })

  return (
    <>
    <main
      style={{
        minHeight: "100vh",
        background: "var(--rpc-bg, transparent)",
        padding: "32px 16px 80px",
        maxWidth: 1200,
        margin: "0 auto",
        color: "var(--rpc-text-primary)",
      }}
    >
      <DegradedDataNotice summary={auxDegraded} />

      {/* ── Header band ────────────────────────────────────────────────── */}
      <nav
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs, 12px)",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--rpc-text-muted)",
          marginBottom: 8,
        }}
      >
        <Link href="/" style={{ color: "inherit", textDecoration: "none" }}>
          RIP PACKS CITY
        </Link>
        <span style={{ margin: "0 8px" }}>·</span>
        {collectionSlugUrl ? (
          <Link
            href={`/${collectionSlugUrl}/overview`}
            style={{ color: "inherit", textDecoration: "none" }}
          >
            {collectionDisplay}
          </Link>
        ) : (
          <span>{collectionDisplay}</span>
        )}
        <span style={{ margin: "0 8px" }}>·</span>
        <span style={{ color: tierColor }}>{tier || "—"}</span>
        {e.set_name ? (
          <>
            <span style={{ margin: "0 8px" }}>·</span>
            <span>{e.set_name.toUpperCase()}</span>
          </>
        ) : null}
      </nav>

      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "clamp(28px, 5vw, 44px)",
          lineHeight: 1.1,
          margin: "0 0 4px",
          letterSpacing: "0.01em",
        }}
      >
        {subject}
        {serial ? (
          <span style={{ color: "var(--rpc-text-muted)", fontWeight: 400 }}>
            {" · #"}{serial}{mint ? `/${mint}` : ""}
          </span>
        ) : null}
      </h1>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm, 13px)",
          color: "var(--rpc-text-muted)",
          marginBottom: 24,
        }}
      >
        {[
          e.series != null ? seriesDisplay(e.series, e.collection_slug) : null,
          e.play_type ?? null,
          fmtAbsDate(e.game_date),
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>

      {/* ── Hero (image + FMV card) ────────────────────────────────────── */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 24,
          marginBottom: 24,
        }}
        className="rpc-moment-hero"
      >
        <div
          style={{
            border: `2px solid ${tierColor}`,
            borderRadius: 12,
            overflow: "hidden",
            background: "var(--rpc-surface, #0a0a0a)",
            aspectRatio: "1 / 1",
            position: "relative",
          }}
        >
          <MomentHeroMedia
            imageCandidates={heroImageCandidates}
            videoUrl={proxyIpfsUrl(e.video_url)}
            alt={subject}
          />
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            padding: 24,
            border: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
            borderRadius: 12,
            background: "var(--rpc-surface, rgba(255,255,255,0.02))",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs, 12px)",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: "var(--rpc-text-muted)",
            }}
          >
            Current FMV
          </div>
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(40px, 7vw, 64px)",
              lineHeight: 1,
              color: showHeroFmv ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
            }}
          >
            {showHeroFmv ? fmtUsd(f?.fmv_usd) : "FMV unavailable"}
          </div>

          {/* ASK-DERIVED disclosure (2026-08-01, Trevor: "disclose basis,
              platform-wide"). Still no confidence TIER on the UI — the enum
              never reaches the DOM. But when confidence is ASK_ONLY the number
              above is 0.90 × one seller's asking price on a moment that has
              never traded, and rendering it as "Current FMV" with nothing else
              said is the overclaim. Plain words, via lib/fmv-basis.ts. */}
          {askBasis && showHeroFmv ? (
            <div
              title={askBasis.title}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs, 12px)",
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: "var(--rpc-warning, #e0a64b)",
                cursor: "help",
              }}
            >
              {askBasis.label} · no sales yet
            </div>
          ) : null}

          {/* Confidence tier removed 2026-07-11 (build-time signal, not
              front-end content) — keep only the factual sales-count basis. */}
          {showSalesCount && (f?.sales_count_30d || f?.sales_count_7d) ? (
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs, 12px)",
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: "var(--rpc-text-muted)",
              }}
            >
              {f?.sales_count_30d
                ? `${f.sales_count_30d} sales / 30d`
                : `${f?.sales_count_7d} sales / 7d`}
            </div>
          ) : null}

          {/* Cleaned 30d price band — turns a high-volume "LOW"/"MEDIUM" badge
              into an honest "actively traded, wide range" signal (2026-06-15). */}
          {showPriceBand && band ? (
            <div
              title={`Typical sale prices over the last 30 days, after dropping dust and outliers${band.n ? ` (${band.n} cleaned sales)` : ""}.`}
              style={{
                marginTop: -6,
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs, 12px)",
                letterSpacing: "0.04em",
                color: "var(--rpc-text-muted)",
              }}
            >
              Actively traded · typical range{" "}
              <span style={{ color: "var(--rpc-text-primary)" }}>
                {fmtUsd(band.low)}–{fmtUsd(band.high)}
              </span>
            </div>
          ) : null}

          {sfmv ? (
            <div
              style={{
                marginTop: 10,
                paddingTop: 10,
                borderTop: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "baseline",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs, 12px)",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    color: "var(--rpc-text-muted)",
                  }}
                >
                  {sfmv.label}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "clamp(20px, 3vw, 28px)",
                    lineHeight: 1,
                    color: "var(--rpc-text-primary)",
                  }}
                >
                  ≈ {fmtUsd(sfmv.estimate_usd)}
                </span>
              </div>
              <div
                style={{
                  marginTop: 4,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-2xs, 10px)",
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "var(--rpc-text-muted)",
                }}
              >
                {/* Hollow ring = this is a guide/estimate, not a sales-backed quote. */}
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    border: "1.5px solid var(--rpc-text-muted)",
                    display: "inline-block",
                  }}
                />
                Estimate, not a quote · {sfmv.multiplier}× the edition FMV
              </div>
            </div>
          ) : null}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
              gap: 12,
              marginTop: 8,
            }}
          >
            {/* "Floor" (recent-sale low) removed 2026-07-07 — redundant with
                the Recent activity table below. */}
            <StatCell label="Avg Sales Price" value={fmtUsd(f?.wap_usd)} />
            <StatCell
              label={ASK_LABEL[collectionSlugUrl ?? ""] ?? "Floor ask"}
              value={fmtUsd(highOffer?.low_ask ?? f?.top_shot_ask ?? f?.cross_market_ask)}
            />
            {hasBestOffer && (
              <StatCell
                label="Best offer"
                value={
                  <span title={bestOfferUpdatedAt ? fmtAbsDate(bestOfferUpdatedAt) : undefined}>
                    {fmtUsd(bestOfferAmount)}
                    {bestOfferGrain === "serial" ? (
                      <span style={{ color: "var(--rpc-red)" }}> · serial</span>
                    ) : bestOfferGrain === "parallel" ? (
                      <span style={{ color: "var(--rpc-red)" }}> · this printing</span>
                    ) : null}
                    {bestOfferUpdatedAt ? (
                      <span style={{ color: "var(--rpc-text-muted)" }}> · {fmtRelDate(bestOfferUpdatedAt)}</span>
                    ) : null}
                  </span>
                }
              />
            )}
          </div>

          {/* Badges row (edition-wide) + special-serial pills (per-NFT only) */}
          {(badges.length > 0 || specialSerials.length > 0 || derivedSerialBadges.length > 0) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
              {derivedSerialBadges.map(label => (
                <span
                  key={`ds-${label}`}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: "3px 9px",
                    background: "var(--rpc-red)",
                    color: "var(--rpc-text-primary, #fff)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs, 11px)",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                  }}
                >
                  <SpecialSerialGlyph tag={label === "#1 Serial" ? "#1" : "perfect"} size={11} collection={e.collection_slug} />
                  {label}
                </span>
              ))}
              {specialSerials.map(s => (
                <span
                  key={`ss-${s.badge_type}-${s.serial_number}`}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    padding: "3px 9px",
                    background: "var(--rpc-red)",
                    color: "var(--rpc-text-primary, #fff)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs, 11px)",
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                  }}
                >
                  <SpecialSerialGlyph tag={s.badge_type} size={11} collection={e.collection_slug} />{specialSerialLabel(s.badge_type)}
                </span>
              ))}
              {badges.map(b => {
                const art = badgeArt.get(normalizeBadgeKey(b.title))
                // Every badge renders as a TEXT-LABELED chip. Art-backed badges
                // (Rookie Mint, Championship Year, ALL DAY Debut, etc.) get the
                // official icon as a small inline prefix; badges with no art are
                // pure text. Previously art-backed badges rendered as an unlabeled
                // 28px icon, so collectors couldn't read which badge it was and
                // whole classes of play_tags/set_play_tags looked "missing".
                return (
                  <span
                    key={`b-${b.id}`}
                    title={b.source ? `${b.title} — source: ${b.source}` : b.title}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "3px 9px",
                      border: "1px solid var(--rpc-border, rgba(255,255,255,0.18))",
                      color: "var(--rpc-text-primary)",
                      background: "var(--rpc-surface-raised)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs, 11px)",
                      letterSpacing: "0.18em",
                      textTransform: "uppercase",
                    }}
                  >
                    {art ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={art}
                        alt=""
                        aria-hidden="true"
                        width={14}
                        height={14}
                        loading="lazy"
                        style={{ width: 14, height: 14, display: "inline-block", flexShrink: 0 }}
                      />
                    ) : null}
                    {b.title}
                  </span>
                )
              })}
            </div>
          )}

          {marketplaceUrl && marketplaceName ? (
            <TrackedOutboundLink
              href={marketplaceUrl}
              payload={{
                surface: "moment",
                destination: `${collectionSlugUrl}_listing`,
                editionKey: e.external_id,
                momentId: marketplaceNftId,
                playerName: e.player_name,
                setName: e.set_name,
                tier: e.tier,
                serial,
                fmv: f?.fmv_usd ?? null,
              }}
              style={{
                marginTop: 4,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                padding: "12px 20px",
                background: "var(--rpc-red)",
                // brand-exception: white label on the red CTA button — theme-independent
                color: "#fff",
                borderRadius: 8,
                textDecoration: "none",
                fontFamily: "var(--font-display)",
                fontWeight: 800,
                fontSize: 14,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              View on {marketplaceName} →
            </TrackedOutboundLink>
          ) : null}

          {dapperUrl ? (
            <TrackedOutboundLink
              href={dapperUrl}
              payload={{
                surface: "moment",
                destination: "dapper_market_listing",
                editionKey: e.external_id,
                momentId: marketplaceNftId,
                playerName: e.player_name,
                setName: e.set_name,
                tier: e.tier,
                serial,
                fmv: f?.fmv_usd ?? null,
              }}
              style={{
                marginTop: 4,
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
              View on Dapper ↗
            </TrackedOutboundLink>
          ) : null}

          {dapperEditionUrl ? (
            <TrackedOutboundLink
              href={dapperEditionUrl}
              payload={{
                surface: "moment",
                destination: "dapper_market_edition",
                editionKey: e.external_id,
                playerName: e.player_name,
                setName: e.set_name,
                tier: e.tier,
                fmv: f?.fmv_usd ?? null,
              }}
              style={{
                marginTop: 4,
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
          ) : null}

          {/* UFC Strike is migrating to Aptos (Flow frozen since May 2026); its Flow moments are no
              longer tradeable on UFC Strike / Dapper, so the marketplace CTAs
              above are intentionally absent. Explain that rather than leaving a
              bare page with no external link and no reason. */}
          {(e.collection_slug === "ufc_strike" || e.collection_slug === "ufc-strike") && !marketplaceUrl && !dapperUrl && !dapperEditionUrl ? (
            <div
              role="note"
              style={{
                marginTop: 4,
                padding: "10px 14px",
                background: "var(--rpc-surface-raised)",
                border: "1px solid var(--rpc-border)",
                borderRadius: 8,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.6,
                color: "var(--rpc-text-secondary)",
                maxWidth: 520,
              }}
            >
              UFC Strike is migrating to the Aptos blockchain; Flow trading has
              been frozen since May 2026. This Flow moment is no longer tradeable
              on UFC Strike or Dapper, so external marketplace links are
              unavailable.
            </div>
          ) : null}

          {/* Watch this edition (FMV / ask alert). Gated to the editions+
              fmv_snapshots collections — Pinnacle FMV lives elsewhere. */}
          {(() => {
            const watchCollectionId =
              r?.collection_id ?? (e.collection_slug ? WATCH_COLLECTION_ID[e.collection_slug] : undefined)
            if (e.collection_slug === "disney_pinnacle" || !e.external_id || !watchCollectionId) return null
            return (
              <div style={{ marginTop: 8 }}>
                <WatchEditionButton
                  editionKey={e.external_id}
                  collectionId={watchCollectionId}
                  playerName={e.player_name}
                  setName={e.set_name}
                />
              </div>
            )
          })()}
        </div>
      </section>

      {/* ── Parallel tier switcher ───────────────────────────────────────── */}
      {/* Quick-jump between parallel printings of this play (Standard / Club
          Collection / …) — same component as the edition page (2026-07-11). */}
      {subSiblings.length >= 2 && collectionSlugUrl && (
        <div style={{ marginTop: -8, marginBottom: 28 }}>
          <ParallelTierSwitcher collection={collectionSlugUrl} siblings={subSiblings} />
        </div>
      )}

      {/* ── Info bar (relocated from footer for visibility) ─────────────── */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
          marginBottom: 32,
        }}
      >
        <StatCell
          label="Mint count"
          value={
            serial != null && mint
              ? `#${serial} / ${mint.toLocaleString()}`
              : mint ? mint.toLocaleString() : "—"
          }
        />
        <StatCell label="Tier" value={tier || "—"} />
        <StatCell label="Series" value={e.series != null ? seriesDisplay(e.series, e.collection_slug) : "—"} />
        <StatCell
          label="Team"
          value={
            e.team_name
              ? (teamHref
                  ? <Link href={teamHref} style={{ color: "var(--rpc-text-primary)", textDecoration: "none" }}>{e.team_name}</Link>
                  : e.team_name)
              : "—"
          }
        />
        <StatCell label="Play type" value={e.play_type && e.play_type !== "Unknown" ? e.play_type : "—"} />
        <StatCell label="Game date" value={fmtAbsDate(e.game_date) || "—"} />
      </section>

      {/* Serial-specific block (when kind='moment') */}
      {r?.kind === "moment" && ss ? (
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Serial #{serial} state</SectionTitle>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
              gap: 12,
            }}
          >
            <StatCell label="Owner" value={<OwnerLink address={ss.owner_address} name={nameFor(ss.owner_address)} />} />
            {/* Listed (Bug 13, 2026-07-03): restored off cached_listings_v2 — the
                live on-chain listing feed — instead of the dead ts_listings source.
                Shows the cheapest active ask for this serial's nft_id, or a dash
                when there's no open listing. See fetchActiveListingAsk. */}
            <StatCell label="Listed" value={fmtUsd(activeListingAsk)} />
            <StatCell
              label="Last sale"
              value={
                ss.last_sale?.price_usd != null
                  ? `${fmtUsd(ss.last_sale.price_usd)} · ${fmtRelDate(ss.last_sale.sold_at)}`
                  : "—"
              }
            />
          </div>
        </section>
      ) : null}

      {/* Special serials (edition-wide notable serials + holders) — Item 2.
          Gated on at least one row carrying a tracked owner or a last sale so
          the section never renders as a hollow list of "—" placeholders. */}
      {notableSerials.length > 0 &&
      notableSerials.some((n) => n.holder_address || n.last_sale_usd != null) ? (
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Special serials</SectionTitle>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs, 11px)",
              color: "var(--rpc-text-muted)",
              marginTop: -4,
              marginBottom: 12,
              letterSpacing: "0.04em",
            }}
          >
            Notable serials — #1, jersey match, and the perfect serial (final mint) — with their last sale and tracked owner where known.
          </div>
          <div
            style={{
              border: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
              borderRadius: 8,
              overflowX: "auto",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-sm, 13px)",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid var(--rpc-border, rgba(255,255,255,0.08))", color: "var(--rpc-text-muted)" }}>
                  <Th>Serial</Th>
                  <Th>Type</Th>
                  <Th>Last sale</Th>
                  <Th>Owner</Th>
                </tr>
              </thead>
              <tbody>
                {notableSerials.map((n) => {
                  const isThisSerial = serial != null && n.serial === serial
                  const accent = n.tag === "#1" || n.tag === "jersey"
                  return (
                    <tr
                      key={`${n.tag}-${n.serial}`}
                      style={{
                        borderBottom: "1px solid var(--rpc-border, rgba(255,255,255,0.04))",
                        background: isThisSerial ? "var(--rpc-red-bg, rgba(224,58,47,0.10))" : undefined,
                      }}
                      title={isThisSerial ? "This serial" : undefined}
                    >
                      <Td>
                        #{n.serial}
                        {isThisSerial ? <span style={{ color: "var(--rpc-red)", marginLeft: 6 }}>●</span> : null}
                      </Td>
                      <Td>
                        <span style={{ color: accent ? "var(--rpc-red)" : "var(--rpc-text-primary)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <SpecialSerialGlyph tag={n.tag} size={11} collection={e.collection_slug} />
                          {notableTagLabel(n.tag)}
                        </span>
                      </Td>
                      <Td>
                        {n.last_sale_usd != null ? (
                          <span title={fmtAbsDate(n.last_sold_at)}>
                            {fmtUsd(n.last_sale_usd)} · {fmtRelDate(n.last_sold_at)}
                          </span>
                        ) : (
                          <span style={{ color: "var(--rpc-text-muted)" }}>never sold</span>
                        )}
                      </Td>
                      <Td>
                        {n.holder_address ? (
                          <OwnerLink address={n.holder_address} name={nameFor(n.holder_address)} />
                        ) : (
                          <span style={{ color: "var(--rpc-text-muted)" }}>—</span>
                        )}
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* Recent activity */}
      <section style={{ marginBottom: 32 }}>
        <SectionTitle>Recent activity</SectionTitle>
        {recentSales.length === 0 ? (
          <EmptyRow>No recorded sales yet.</EmptyRow>
        ) : (
          <div
            style={{
              border: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
              borderRadius: 8,
              overflowX: "auto",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-sm, 13px)",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid var(--rpc-border, rgba(255,255,255,0.08))", color: "var(--rpc-text-muted)" }}>
                  <Th>Serial</Th>
                  {recentSales.some(x => x.parallel != null && x.parallel !== "") && <Th>Parallel</Th>}
                  <Th>Price</Th>
                  <Th>When</Th>
                  <Th>Buyer</Th>
                  <Th>Seller</Th>
                </tr>
              </thead>
              <tbody>
                {recentSales.map((s, i) => {
                  const isThisSerial = r?.kind === "moment" && serial != null && s.serial_number === serial
                  const hasParallelCol = recentSales.some(x => x.parallel != null && x.parallel !== "")
                  return (
                  <tr
                    key={`${s.sold_at}-${s.serial_number}-${i}`}
                    style={{
                      borderBottom: "1px solid var(--rpc-border, rgba(255,255,255,0.04))",
                      background: isThisSerial ? "var(--rpc-red-bg, rgba(224,58,47,0.10))" : undefined,
                    }}
                    title={isThisSerial ? "This serial" : undefined}
                  >
                    <Td>
                      {s.serial_number != null && s.serial_number > 0 ? `#${s.serial_number}` : "—"}
                      {isThisSerial ? <span style={{ color: "var(--rpc-red)", marginLeft: 6 }}>●</span> : null}
                    </Td>
                    {hasParallelCol ? (
                      <Td>
                        <span style={{ color: s.parallel && s.parallel !== "Standard" ? "var(--rpc-red)" : "var(--rpc-text-muted)" }}>
                          {s.parallel ?? "—"}
                        </span>
                      </Td>
                    ) : null}
                    <Td>{fmtUsd(s.price_usd)}</Td>
                    <Td>
                      <span title={fmtAbsDate(s.sold_at)}>{fmtRelDate(s.sold_at)}</span>
                    </Td>
                    <Td><OwnerLink address={s.buyer_address} name={nameFor(s.buyer_address)} /></Td>
                    <Td><OwnerLink address={s.seller_address} name={nameFor(s.seller_address)} /></Td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Parallels (same player + same play_id_onchain, different set) */}
      {parallels.length > 0 ? (
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Parallels</SectionTitle>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            {parallels.map((p) => (
              <Link
                key={p.id}
                href={`/moment/${p.id}`}
                style={{
                  textDecoration: "none",
                  color: "inherit",
                  border: "1px solid var(--rpc-red)",
                  borderRadius: 8,
                  overflow: "hidden",
                  background: "var(--rpc-surface, rgba(255,255,255,0.02))",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ aspectRatio: "1 / 1", background: "var(--rpc-bg, #000)" }}>
                  {p.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.thumbnail_url}
                      alt={p.player_name ?? "parallel"}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      loading="lazy"
                    />
                  ) : null}
                </div>
                <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 15, lineHeight: 1.2 }}>
                    {p.set_name ?? "—"}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs, 11px)",
                      color: "var(--rpc-text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.12em",
                    }}
                  >
                    {(p.tier ?? "").toUpperCase()}
                    {p.circulation_count != null ? ` · ${p.circulation_count.toLocaleString()} mint` : ""}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* Similar editions */}
      {similar.length > 0 ? (
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Similar editions</SectionTitle>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            {similar.slice(0, 6).map((s) => (
              <Link
                key={s.id}
                href={`/moment/${s.id}`}
                style={{
                  textDecoration: "none",
                  color: "inherit",
                  border: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
                  borderRadius: 8,
                  overflow: "hidden",
                  background: "var(--rpc-surface, rgba(255,255,255,0.02))",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ aspectRatio: "1 / 1", background: "var(--rpc-bg, #000)" }}>
                  {s.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={s.thumbnail_url}
                      alt={s.player_name ?? "moment"}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      loading="lazy"
                    />
                  ) : null}
                </div>
                <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 15, lineHeight: 1.2 }}>
                    {s.player_name ?? "—"}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs, 11px)",
                      color: "var(--rpc-text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.12em",
                    }}
                  >
                    {(s.tier ?? "").toUpperCase()}{s.series != null ? " · " + seriesDisplay(s.series, e.collection_slug) : ""} · {s.set_name ?? "—"}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-sm, 13px)",
                      color: s.fmv_usd != null ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
                    }}
                  >
                    {s.fmv_usd != null ? fmtUsd(s.fmv_usd) : "No sales"}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <div
        style={{
          marginTop: 48,
          paddingTop: 24,
          borderTop: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs, 11px)",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--rpc-text-muted)",
          textAlign: "center",
        }}
      >
        Powered by Rip Packs City
      </div>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productLd) }}
      />

      <style>{`
        @media (min-width: 768px) {
          .rpc-moment-hero {
            grid-template-columns: 1fr 1fr !important;
          }
        }
      `}</style>
    </main>
    <SiteFooter />
    </>
  )
}

// Presentational helpers

// Wave 2 (PIN-FMV-REKEY): "Pick a pin" list for a Pinnacle legacy edition_key
// that fans out to multiple renders. Each card links to the render-true per-pin
// page at /pinnacle/moment/<render_id> (the canonical Pinnacle surface).
function PinnacleDisambiguation({ renders }: { renders: PinnacleRender[] }) {
  return (
    <>
      <main
        style={{
          minHeight: "100vh",
          background: "var(--rpc-bg, transparent)",
          padding: "32px 16px 80px",
          maxWidth: 1200,
          margin: "0 auto",
          color: "var(--rpc-text-primary)",
        }}
      >
        <nav
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs, 12px)",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--rpc-text-muted)",
            marginBottom: 8,
          }}
        >
          <Link href="/" style={{ color: "inherit", textDecoration: "none" }}>
            RIP PACKS CITY
          </Link>
          <span style={{ margin: "0 8px" }}>·</span>
          <Link href="/disney-pinnacle/overview" style={{ color: "inherit", textDecoration: "none" }}>
            DISNEY PINNACLE
          </Link>
        </nav>

        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "clamp(28px, 5vw, 44px)",
            lineHeight: 1.1,
            margin: "0 0 8px",
            letterSpacing: "0.01em",
          }}
        >
          Pick a pin
        </h1>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm, 13px)",
            color: "var(--rpc-text-muted)",
            marginBottom: 24,
          }}
        >
          {renders.length} distinct renders share this set-level key — each is a different character / variant with its own price.
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {renders.map((r) => (
            <Link
              key={r.render_id}
              href={`/pinnacle/moment/${encodeURIComponent(r.render_id)}`}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                textDecoration: "none",
                color: "inherit",
                border: "1px solid var(--rpc-border, rgba(255,255,255,0.08))",
                borderRadius: 8,
                overflow: "hidden",
                background: "var(--rpc-surface, rgba(255,255,255,0.02))",
                padding: 10,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={r.thumbnail_url ?? `/api/public/pinnacle-image/${encodeURIComponent(r.render_id)}`}
                alt={r.character_name ?? "Pinnacle pin"}
                width={72}
                height={72}
                style={{ width: 72, height: 72, objectFit: "contain", flexShrink: 0, borderRadius: 4, background: "var(--rpc-bg, #000)" }}
                loading="lazy"
              />
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 15, lineHeight: 1.2 }}>
                  {r.character_name ?? r.render_id}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs, 11px)",
                    color: "var(--rpc-text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.12em",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.variant ?? "—"}
                  {r.total_minted != null ? ` · ${r.total_minted.toLocaleString()} mint` : ""}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-sm, 13px)",
                    color: r.fmv_usd != null ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
                  }}
                >
                  {r.fmv_usd != null ? fmtUsd(r.fmv_usd) : "—"}
                </div>
              </div>
            </Link>
          ))}
        </div>

        <div
          style={{
            marginTop: 32,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs, 11px)",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
          }}
        >
          <Link href="/insights/pinnacle-scarcity" style={{ color: "var(--rpc-text-muted)", textDecoration: "none" }}>
            ← Pinnacle scarcity board
          </Link>
        </div>
      </main>
      <SiteFooter />
    </>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs, 12px)",
        letterSpacing: "0.22em",
        textTransform: "uppercase",
        color: "var(--rpc-text-muted)",
        marginBottom: 12,
      }}
    >
      {children}
    </div>
  )
}

function StatCell({ label, value }: { label: string; value: React.ReactNode }) {
  const titleAttr = typeof value === "string" ? value : undefined
  return (
    <div
      style={{
        padding: "10px 12px",
        border: "1px solid var(--rpc-border, rgba(255,255,255,0.06))",
        borderRadius: 8,
        background: "var(--rpc-bg-elev, rgba(255,255,255,0.02))",
        minHeight: 56,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 4,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs, 11px)",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--rpc-text-muted)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm, 14px)",
          color: "var(--rpc-text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={titleAttr}
      >
        {value}
      </div>
    </div>
  )
}

function OwnerLink({ address, name }: { address: string | null | undefined; name?: string | null }) {
  if (!address) return <span style={{ color: "var(--rpc-text-muted)" }}>—</span>
  const lower = address.toLowerCase().startsWith("0x") ? address.toLowerCase() : `0x${address.toLowerCase()}`
  const trunc = address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
  return (
    <Link
      href={`/profile/${lower}`}
      title={name ? `${name} · ${address}` : address}
      style={{ color: "var(--rpc-text-primary)", textDecoration: "none" }}
    >
      {name ? `@${name}` : trunc}
    </Link>
  )
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "20px 16px",
        border: "1px dashed var(--rpc-border, rgba(255,255,255,0.08))",
        borderRadius: 8,
        textAlign: "center",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-sm, 13px)",
        color: "var(--rpc-text-muted)",
      }}
    >
      {children}
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: "10px 12px",
        textAlign: "left",
        fontWeight: 400,
        fontSize: "var(--text-xs, 11px)",
        letterSpacing: "0.16em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </th>
  )
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td style={{ padding: "10px 12px" }}>
      {children}
    </td>
  )
}

/**
 * Shown when the moment READ failed — never when the moment genuinely does not
 * exist (that is still `notFound()`).
 *
 * ⚠ Deliberately NOT a 404. This is the platform's most-shared URL, so a 404 for
 * a real moment is a hard "this does not exist" served to a collector who just
 * posted the link and to any crawler that follows it. The page also carries
 * `robots: noindex, follow` in that branch so a transient failure cannot
 * de-index a real moment.
 */
function MomentUnavailableCard({ id }: { id: string }) {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "64px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <h1
        style={{
          margin: 0,
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: 28,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--rpc-text-primary)",
        }}
      >
        This moment didn&apos;t load
      </h1>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "var(--rpc-text-secondary)" }}>
        The catalog is under heavy load right now. This says nothing about whether the moment
        exists — only that we couldn&apos;t read it. Reload in a moment.
      </p>
      <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>
        {id}
      </p>
    </main>
  )
}
