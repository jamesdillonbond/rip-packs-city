// app/(collections)/[collection]/pack/dist/[distId]/page.tsx
//
// Pack DISTRIBUTION (template) detail surface — server-rendered from cached
// EV snapshots (pack_table_rows ← pack_ev_latest ← pack_ev_history) plus
// the pack_drop_pool → editions → fmv join for the top-pulls table.
//
// This route describes a pack TEMPLATE (e.g. "Series 5 Common Pack"), not a
// specific minted pack instance. For an individual on-chain pack NFT (the
// lifecycle / rip view) see /[collection]/pack/[id]/page.tsx, which uses the
// get_pack_lifecycle RPC keyed on the pack NFT id.
//
// Top Shot and All Day reach this route today. PackTable routes its row
// click here via detailHref. Golazos packs surface was removed 2026-05-19
// — see lib/collections.ts pages array.

import type { Metadata } from "next"
import { Suspense } from "react"
import { topshotPackUrl, dapperMarketPackUrl } from "@/lib/pack-urls"
import Link from "next/link"
import { notFound } from "next/navigation"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { resolveUsernames } from "@/lib/flowty-username"
import PackHeroArt from "@/components/packs/PackHeroArt"
// tierChip moved to lib/tier-style.ts so this server component can call it;
// the version exported from PackTable.tsx ('use client') would throw at
// runtime — that's the bug this page was hitting before 2026-05-26.
import { tierChip } from "@/lib/tier-style"
import PackShareButton from "@/components/packs/PackShareButton"
import TrackedOutboundLink from "@/components/TrackedOutboundLink"
import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import { OG_INHERITED, TWITTER_INHERITED, packJsonLd } from "@/lib/seo"
import { humanizeLabel, joinMetaParts, metaField } from "@/lib/format"
import {
  num,
  fmtUsd,
  fmtUsdEv,
  packOddsLabel,
  relTimeShort,
  fmtAgo,
  fmtSalePrice,
  fmtPct,
  fmtCount,
  tsTileImg,
} from "@/lib/pack-dist-format"
import { sumPoolRemaining, orderedTiersWithSupply, pctOfPoolLabel, deriveDualPrice, computeTopPulls, type TopPull } from "@/lib/pack-dist-odds"
import {
  detectHoldingPack,
  deriveSecondaryAskAnchor,
  deriveEvVerdict,
  isEvInflatedVsAsk,
  isSurvivorBiased,
  isEvSnapshotStale,
  deriveRealizedVsModeledVerdict,
  deriveSealedResaleVerdict,
  showCalibrated as computeShowCalibrated,
  evContributorsLowConfShare as computeEvContributorsLowConfShare,
  deriveGrailPremium,
} from "@/lib/pack-dist-verdict"
// The data-access layer moved to lib/ (2026-08-13) so it lands inside the primary
// coverage gate — `app/**/page.tsx` is measured by neither gate — and so each
// fetcher can report `ok: false` on a query failure instead of returning an empty
// value the page then renders as a fact about the catalogue. See the module header.
import {
  fetchPackRow,
  fetchDistFallback,
  fetchPackLifecycle,
  fetchPackRealizedEv,
  fetchAllDayCorrectedEv,
  fetchPackMarket,
  fetchEvContributors,
  fetchTopPulls,
  fetchPackContents,
  fetchExhaustedCount,
  fetchPackSalesHistory,
  type PackTableRow,
  type DistFallbackRow,
  type PackSaleRow,
  type AllDayCorrectedEvRow,
  type HeroEdition,
  fetchPackDetailBundle,
} from "@/lib/pack-dist/fetchers"
import { summarizeDegraded, boardStatus } from "@/lib/insights/board-status"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"

export const revalidate = 600
export const dynamicParams = true

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

const CARD_STYLE: React.CSSProperties = {
  background: "rgba(13,13,13,0.92)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 8,
  padding: 18,
}




const PACK_CONTENTS_PAGE_SIZE = 24


// PACKVIZ-GRID 2a — the top-5-by-FMV "hero strip". get_pack_contents orders by
// EV-per-slot (FMV × drop_weight), so a high-FMV / low-weight chase card sorts
// far down its list — the headline pulls need their own FMV-ordered fetch.
// Top Shot legacy thumbnail_url (assets.nbatopshot.com/editions/…) 404s for
// Series 1-4 editions; the per-moment media/<nft_id>/image form works for every
// TS moment, so prefer it when a representative nft_id is available (Item 1,
// 2026-06-22 audit). Server-rendered surfaces have no onError fallback, so this
// returns the single best URL.
// tsTileImg extracted to @/lib/pack-dist-format (imported above).


// Hero editions (top-5 by FMV) now come from get_pack_detail_bundle in the shell
// (P3) — the standalone fetch was retired to keep it on the single bundle RPC.


// editions.name is "Player Name — Set Name" (em-dash). Some rows are NULL.
// Fall back gracefully so the table doesn't render literal "null —" cells.
// splitEditionName / num / fmtUsd / fmtUsdEv extracted to @/lib/pack-dist-format
// (imported below) so the pack-EV display math is unit-tested.

// fmtPct / fmtCount extracted to @/lib/pack-dist-format (imported above).

// fmtAgo extracted to @/lib/pack-dist-format (imported below).

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(
  props: { params: Promise<{ collection: string; distId: string }> },
): Promise<Metadata> {
  const { collection, distId } = await props.params
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return {}
  // ⚠ BOTH `ok` flags are load-bearing. The page body a few hundred lines below
  // already distinguishes "this dist does not exist" from "the read failed" —
  // that fix exists because timeouts were rendering real packs as 404s — but
  // this function used to drop both flags and treat a failed read as absence.
  // It is the same page, the same distinction, and it was fixed in one function
  // and not the other. This surface carries the platform's highest timeout count
  // (Sentry NEXTJS-1Z, 86 users), and metadata reads its OWN rows rather than the
  // body's bundle, so a metadata read can fail while the page renders perfectly:
  // a real, working pack page with no title, no description, no canonical and no
  // OG image, still indexable. Metadata output is invisible in the browser and
  // only ever seen in someone else's timeline, which is why nobody noticed.
  const { data: row, ok: rowOk } = await fetchPackRow(coll.id, distId)
  const fbRes = row ? null : await fetchDistFallback(coll.id, distId)
  const fb: DistFallbackRow | null = fbRes?.data ?? null
  const readOk = rowOk && (fbRes ? fbRes.ok : true)
  // metaField (2026-07-25): pack_distributions.title is raw catalog text and can
  // carry stray whitespace, which leaked ahead of the " — " / " | " separators in
  // the title and ahead of the "." in the description's first sentence.
  const title = metaField(row?.title) ?? metaField(fb?.title) ?? "Pack"
  if (!row && !fb) {
    // Only an ANSWERED read may let this page fall back to the site's generic
    // metadata, which is what an empty object means. A FAILED read says so and
    // withholds indexing for this fetch — `follow: true` keeps the link equity,
    // and the next crawl of a recovered page indexes normally. Mirrors the
    // /moment/[id] branch, which is the canonical shape for this.
    return readOk
      ? {}
      : {
          title: { absolute: "Pack Unavailable — Rip Packs City" },
          description: "We couldn't load this pack right now. Try again in a moment.",
          robots: { index: false, follow: true },
        }
  }
  const tierLabel = row?.tier ? humanizeLabel(String(row.tier)) : ""
  const metaTitle = `${joinMetaParts([title, tierLabel], " — ")} | ${coll.displayName} | Rip Packs City`
  // AllDay: prefer the odds/median-corrected EV (matches the page headline) so
  // the SEO description never advertises the inflated canonical number.
  // ⚠ Honour `ok`: a FAILED corrected-EV read used to fall through to the raw
  // `row.gross_ev` — the exact inflated number the comment above says must not
  // be advertised — because only `data` was destructured (2026-09-04). A failed
  // read withholds the EV sentence; the page body reads its own bundle.
  const correctedEvRes = await fetchAllDayCorrectedEv(collection, distId)
  const correctedEv = correctedEvRes.data
  const correctedEvReadFailed = !correctedEvRes.ok
  const useCorrectedEv = correctedEv != null && correctedEv.corrected_gross_ev != null
  const grossEv = correctedEvReadFailed
    ? null
    : useCorrectedEv ? num(correctedEv!.corrected_gross_ev) : num(row?.gross_ev ?? null)
  const price = num(row?.retail_price_usd ?? null)
  // Holding/escrow packs carry sentinel prices ($9,999/$99,999/$999,999) — keep
  // them out of the SEO description so it doesn't advertise a $900K "Gross EV".
  const isHoldingPack = detectHoldingPack({ title, prices: [price] })
  // Never advertise a survivor-biased pull-value EV in the SEO description. A
  // depleted TS pack's drop pool retains only its rare chases, inflating the raw
  // gross EV 40–86× (e.g. dist 5223: "Gross EV $801 · 80x" on a $10 pack). Drop
  // the EV + value-ratio sentences when the pool is ≥90% depleted or the gross EV
  // exceeds 3× a live secondary ask. AllDay already substitutes the odds-corrected
  // number above (useCorrectedEv), so this guards only the raw TS path. Mirrors
  // the page's evSurvivorBiased gate. See [[pack-ev-view-dataquality-footguns]].
  const evDepPct = num(row?.ev_depletion_pct ?? null)
  const secAsk = num(row?.secondary_ask ?? null)
  const seoSurvivorBiased = isSurvivorBiased({
    useCorrectedEv,
    depletionPct: evDepPct,
    secondaryAvailable: row?.secondary_available,
    secondaryAsk: secAsk,
    grossEv,
  })
  // ⚠ The unfurl must not publish a stale EV either. Same 72h bar as the page
  // body and the deals surface — a figure four days old is not a claim about the
  // market now, and metadata is the one surface where nobody can see the
  // methodology footnote that carries the timestamp.
  const seoEvStale = isEvSnapshotStale({ snapshottedAt: row?.ev_snapshotted_at ?? null })
  const descParts = [
    `${title} on ${coll.displayName}.`,
    !isHoldingPack && price !== null ? `Retail ${fmtUsd(price)}.` : null,
    !isHoldingPack && !seoSurvivorBiased && !seoEvStale && grossEv !== null ? `Value still sealed ≈ ${fmtUsd(grossEv)}.` : null,
    "Pack EV vs live secondary ask, top pulls, and depletion based on Rip Packs City's cached snapshot.",
  ].filter(Boolean) as string[]
  const canonical = `${BASE_URL}/${collection}/pack/dist/${encodeURIComponent(distId)}`
  const ogImage = `${BASE_URL}/api/og/pack?distId=${encodeURIComponent(distId)}&collection=${encodeURIComponent(collection)}`
  return {
    // `absolute`: this title already carries the brand, and the collection
    // subtree now re-declares the `%s | Rip Packs City` template (R31).
    title: { absolute: metaTitle },
    description: descParts.join(" "),
    alternates: { canonical },
    openGraph: {
      ...OG_INHERITED,
      title: metaTitle,
      description: descParts.join(" "),
      url: canonical,
      siteName: "Rip Packs City",
      type: "website",
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      ...TWITTER_INHERITED,
      card: "summary_large_image",
      title: metaTitle,
      description: descParts.join(" "),
      images: [ogImage],
    },
  }
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function PackDetailPage(
  props: { params: Promise<{ collection: string; distId: string }> },
) {
  const { collection, distId } = await props.params
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  // P3: one-RPC shell bundle (pack_row + dist_fallback + AllDay corrected_ev +
  // top-5 FMV hero editions + has_pool) on ONE connection, replacing the prior
  // 10-way per-request Promise.all fan-out that saturated the connection pool
  // (~58 statement-timeouts/24h). The heavy below-the-fold sections now
  // Suspense-stream on their own connections, off the critical path.
  // rpcWithRetry: the shell bundle is the throw-or-404 gate, so retry
  // connection-class errors (incl. "Timed out acquiring connection from
  // connection pool") in-process before surfacing — a transient pool blip no
  // longer flips a real dist to the retryable error boundary on the first miss.
  const { bundle, error: bundleErr } = await fetchPackDetailBundle(coll.id, distId, collection)
  const row = bundle.pack_row ?? null
  const fallback = bundle.dist_fallback ?? null
  if (!row && !fallback) {
    // Distinguish "this dist does not exist" from "the bundle RPC failed"
    // (statement timeout under contention). The latter was rendering real
    // packs as 404s intermittently, so the failure must not be a 404.
    //
    // ⚠ THIS USED TO `throw` "so the error boundary shows a retryable state".
    // MEASURED 2026-08-23: that intent does not hold. This route is ISR, so the
    // throw happens during page GENERATION, not while a mounted tree renders —
    // `error.tsx` never runs and Next serves its own UNBRANDED default 500.
    // 581 occurrences across 515 distinct users in 7 days did exactly that.
    // The sibling error.tsx is kept: it still covers client-side render errors.
    //
    // Rendering the retryable state directly achieves what the throw intended.
    if (bundleErr) return <PackUnavailable collection={collection} />
    notFound()
  }

  // When pack_table_rows misses (newly minted dist the cron hasn't picked up),
  // synthesize a minimal shape from pack_distributions. EV / depletion will
  // render as em-dash but the page still resolves with a hero + buy link.
  const merged: PackTableRow = row ?? {
    dist_id: distId,
    collection_id: coll.id,
    collection_name: coll.displayName,
    collection_slug: collection,
    title: fallback?.title ?? null,
    image_url: fallback?.image_url ?? null,
    nft_type: null,
    tier: typeof fallback?.metadata?.tier === "string" ? (fallback.metadata.tier as string) : null,
    pack_type: typeof fallback?.metadata?.pack_type === "string" ? (fallback.metadata.pack_type as string) : null,
    description: null,
    retail_price_usd:
      typeof fallback?.metadata?.retail_price_usd === "number"
        ? (fallback.metadata.retail_price_usd as number)
        : typeof fallback?.metadata?.retail_price_usd === "string"
          ? (fallback.metadata.retail_price_usd as string)
          : null,
    slots:
      typeof fallback?.metadata?.number_of_pack_slots === "number"
        ? (fallback.metadata.number_of_pack_slots as number)
        : typeof fallback?.metadata?.number_of_pack_slots === "string"
          ? Number(fallback.metadata.number_of_pack_slots)
          : null,
    total_minted: null,
    total_opened: null,
    total_sealed: null,
    depletion_pct: null,
    pack_ev: null,
    gross_ev: null,
    typical_ev: null,
    ev_pack_price: null,
    value_ratio: null,
    is_positive_ev: null,
    fmv_coverage_pct: null,
    edition_count: null,
    total_unopened: null,
    ev_depletion_pct: null,
    ev_snapshotted_at: null,
    ev_margin_pct: null,
    is_rare_single_pack: null,
    primary_price: null,
    secondary_ask: null,
    price_source: null,
    primary_available: null,
    secondary_available: null,
  }

  const distMetadata = fallback?.metadata ?? null

  // From the shell bundle: AllDay corrected EV (shell-critical — overrides the
  // headline EV), the top-5 FMV hero editions (montage fallback + hero strip),
  // and whether a real drop pool exists. Everything else streams below.
  const correctedEv: AllDayCorrectedEvRow | null = bundle.corrected_ev ?? null
  const heroEditions: HeroEdition[] = Array.isArray(bundle.hero_editions) ? bundle.hero_editions : []
  const hasPoolFromBundle = bundle.has_pool === true

  // Defensive: pack_table_rows.tier is typed string|null but coerce in case
  // the view ever returns a non-string. Same for title.
  const tier = String(merged.tier ?? "common").toLowerCase()
  const chip = tierChip(tier)
  const tierAccent = chip.color
  const title = String(merged.title ?? "Pack")
  // Canonical EV from pack_table_rows (← pack_ev_latest). For AllDay this is the
  // flat-trimmed-mean number that ignores pull odds; prefer the corrected EV below.
  const grossEvRaw = num(merged.gross_ev)
  const packEvRaw = num(merged.pack_ev)
  // AllDay: substitute the odds/median-robust corrected GROSS EV (v_allday_pack_info)
  // at the source so every downstream render site (KPI grid, pct-vs-ask callout,
  // verdict, SEO) uses the corrected sealed-value number. The net/ratio verdict
  // itself is then computed uniformly against the live secondary ask below.
  const useCorrectedEv =
    collection === "nfl-all-day" && correctedEv != null && correctedEv.corrected_gross_ev != null
  // Gross EV = value of the moments still sealed. AllDay substitutes the
  // odds/median-robust corrected gross so every downstream site uses it. The
  // NET/ratio/margin verdict is derived lower down against the live secondary
  // ask ONLY (never retail/primary) — see secondaryAskAnchor below.
  const grossEv = useCorrectedEv ? num(correctedEv!.corrected_gross_ev) : grossEvRaw
  // Typical Pull EV (2026-07-16) — slots × weighted-MEDIAN moment value over the
  // remaining pool. Where Actual EV (grossEv, the weighted MEAN) swings as grails
  // deplete, Typical Pull sits near the common floor and barely moves; the gap is
  // the "grail premium" — how lottery-shaped the pack is.
  //
  // 2026-08-01 FIX: this used to be `useCorrectedEv ? null : num(...)`, which
  // blanked Typical Pull on 461 of the 470 priced NFL All Day pack pages that
  // HAVE the value (the AllDay corrected-EV override is in play on nearly all of
  // them). The public pack-EV block is required to LEAD with Typical Pull rather
  // than Actual EV, so AllDay was leading with exactly the number policy says to
  // de-emphasise. typical_ev is a STANDALONE statistic straight off
  // pack_ev_latest ("a typical pull is worth ~$X") — it does not depend on which
  // mean we display, so it is always safe to show. What is NOT safe under the
  // override is the DERIVED grail premium (Actual − Typical), because the AllDay
  // corrected gross comes from a different model than the median; that
  // comparison is gated on `grailPremiumComparable` below instead.
  const typicalEv = num(merged.typical_ev)
  // Actual EV and Typical Pull are only differenceable when both come from the
  // SAME pack_ev_latest row. The AllDay corrected-EV substitution replaces Actual
  // from v_allday_pack_info, so the gap would be a model artefact, not a premium.
  const grailPremiumComparable = !useCorrectedEv
  const fmvCoverage = merged.fmv_coverage_pct
  const depletion = merged.depletion_pct
  const totalUnopened = num(merged.total_unopened)
  const editionCount = num(merged.edition_count)
  const retailPrice = num(merged.retail_price_usd)
  const evPackPrice = num(merged.ev_pack_price)
  const primaryPrice = num(merged.primary_price)
  const secondaryAsk = num(merged.secondary_ask)
  const priceSource = merged.price_source ?? null
  const primaryAvailable = merged.primary_available === true
  const secondaryAvailable = merged.secondary_available === true
  // ── Verdict anchor (2026-07-07 reframe) ─────────────────────────────────
  // Pack EV compares the value of the moments STILL SEALED (grossEv) ONLY to
  // the live secondary sealed-pack low ask — what the pack itself actually
  // resells for. Primary/retail price is irrelevant to that question. When
  // there's no live secondary ask we show Gross EV informationally but render
  // NO net/ratio/positive-EV verdict. secondaryAsk/secondaryAvailable derive
  // from the same Dapper Studio aggregation as pack_ask_state.lowest_ask.
  const secondaryAskAnchor = deriveSecondaryAskAnchor(secondaryAvailable, secondaryAsk)
  const { packEv, valueRatio, evMargin, isPositive } = deriveEvVerdict(grossEv, secondaryAskAnchor)
  // livePrice is retained ONLY as a display / sentinel-detection price (the KPI
  // price tile, holding-pack sentinel, buy payload) — never as a verdict anchor.
  const livePrice =
    priceSource === "primary" ? primaryPrice
    : priceSource === "secondary" ? secondaryAsk
    : priceSource === "min" ? primaryPrice
    : evPackPrice ?? retailPrice
  const snapshottedAt = merged.ev_snapshotted_at

  // "What's Inside" is read HERE, in the shell, rather than in the streamed
  // bottom group — see the PackContentsSection call below for why (the streamed
  // swap never lands on the client, and a Suspense fallback cannot self-rescue
  // because React does not hydrate a dehydrated boundary's fallback). Both reads
  // are cheap and were MOVED off the streamed group, not added, so total DB work
  // per request is unchanged.
  const [packContentsRes, exhaustedRes] = await Promise.all([
    fetchPackContents(coll.id, distId, PACK_CONTENTS_PAGE_SIZE, 0),
    fetchExhaustedCount(coll.id, distId),
  ])
  // `null` still means "the read failed" for PackContentsSection, which renders
  // its own explanatory copy; `[]` still means a genuinely unindexed pool.
  const packContents = packContentsRes.ok ? (packContentsRes.rows as EditionTile[]) : null
  const exhaustedCount = exhaustedRes.count
  // The exhausted count has no place of its own to say "unknown" — it renders as
  // a bare number in a section header — so a failed count is surfaced through the
  // shared degraded notice rather than published as a measured zero.
  const shellDegraded = summarizeDegraded([boardStatus("Exhausted pool count", exhaustedRes.ok)])

  // Reward / quest packs ship with retail_price_usd = 0 (Pack D1). Value-ratio
  // and EV-margin verdicts divide by retail, so they produce garbage on free
  // packs — gate them off and surface a "Reward pack" badge instead.
  const isRewardPack = retailPrice === 0
  // Holding / Holder / Hold packs (chiefly NFL All Day) are escrow/placeholder
  // constructs, not consumer packs — they carry sentinel prices ($9,999 /
  // $99,999 / $999,999) that produce nonsense verdicts ($900K "Gross EV", 3%
  // coverage), OR a pack_ev clamped to the view's -10000 floor when pack_price
  // dwarfs gross_ev by >$10k (an escrow/whale signature even when the price
  // isn't a canonical sentinel). Detect and suppress the price + EV verdict,
  // mirroring the reward-pack handling. detectHoldingPack reads the CANONICAL
  // net (packEvRaw) so the AllDay corrected override can't mask a clamped
  // escrow sentinel. (Items 4/11, 2026-06-22/26 audits.)
  const isHoldingPack = detectHoldingPack({
    title,
    packEvNet: packEvRaw,
    prices: [retailPrice, livePrice],
  })
  // Verdict renders ONLY when there is a live secondary ask to compare against
  // (2026-07-07 reframe). No ask → Gross EV shows, but no net/ratio/positive-EV.
  const showPriceVerdict = !isRewardPack && !isHoldingPack && secondaryAskAnchor != null
  // Prices fed to the KPI block; suppressed for holding packs so the card shows
  // "—" instead of a $999,999 sentinel.
  const displayLivePrice = isHoldingPack ? null : livePrice
  const displayRetailPrice = isHoldingPack ? null : retailPrice

  // Does this distribution have a real, indexed drop pool? Gates the
  // pull-odds-by-tier panel (which otherwise renders pack-count-by-tier as if
  // it were pool entries on no-pool packs — Pack 1b) and the EV-sentinel
  // honesty path (Pack 1c).
  const hasDropPool = hasPoolFromBundle || (editionCount != null && editionCount > 0)

  // 1c — A no-pool pack's latest EV row is a sentinel (edition_count 0 /
  // fmv_coverage null|0). Rendering "$0.00 Gross EV / Net +$0.00" reads as
  // "this pack is worthless" and contradicts the empty state below; show an
  // em-dash + "awaiting pool data" and suppress the Net line instead.
  const isSentinelEv = !hasDropPool && ((editionCount ?? 0) === 0 || !fmvCoverage)

  // Typical Pull display: show whenever the complete-pool median EV is present and
  // the pack isn't a holding/sentinel construct. Unlike Actual EV, it stays honest
  // even on depleted pools (it IS the common-floor number), so it is NOT blanked by
  // the survivor-bias gate. Grail premium = Actual − Typical: only surfaced as a
  // "lottery" chip when the gap is a meaningful share of Actual EV (≥15% and ≥$0.50).
  const showTypicalPull = typicalEv != null && !isHoldingPack && !isSentinelEv
  const { grailPremium, isLotteryShaped } = deriveGrailPremium(
    grossEv,
    typicalEv,
    grailPremiumComparable,
    showTypicalPull,
  )

  // 1f — Hero montage fallback: top-4-by-FMV pool thumbnails, used by
  // PackHeroArt when the pack's own image_url is dead/missing. Prefer the
  // working media/<nft_id>/image form for Top Shot (legacy editions/ thumbnails
  // 404 — Item 1, 2026-06-22 audit).
  // Hero montage fallback: top-4 by FMV from the bundle's hero editions (already
  // FMV-desc). Prefer the working media/<nft_id>/image form for Top Shot.
  const montageThumbs = heroEditions
    .map((e) => tsTileImg(collection, e.rep_nft_id, e.thumbnail_url))
    .filter((u): u is string => !!u)
    .slice(0, 4)

  // ── Tier-count metadata (PACKVIZ) ──────────────────────────────────────────
  // compute-topshot-pack-ev v20 persists per-pack remaining/original counts-by-tier
  // + total_unopened/total_pack_count into pack_distributions.metadata as its EV
  // sweep touches each pack. Present only on packs the v20 sweep has reached.
  const tierCountsUpdatedAt = typeof distMetadata?.tier_counts_updated_at === "string" ? distMetadata.tier_counts_updated_at : null
  const metaTotalUnopened = num((distMetadata?.total_unopened as string | number | null | undefined) ?? null)
  const metaTotalPackCount = num((distMetadata?.total_pack_count as string | number | null | undefined) ?? null)
  const remainingByTier = distMetadata && typeof distMetadata.remaining_by_tier === "object" && distMetadata.remaining_by_tier !== null
    ? (distMetadata.remaining_by_tier as Record<string, number>) : null
  const originalByTier = distMetadata && typeof distMetadata.original_counts_by_tier === "object" && distMetadata.original_counts_by_tier !== null
    ? (distMetadata.original_counts_by_tier as Record<string, number>) : null
  // Freshest packs-remaining figure: prefer the v20 metadata, else the cached view.
  const liveUnopened = metaTotalUnopened ?? totalUnopened
  const oddsSlots = merged.slots && merged.slots > 0 ? merged.slots : null

  // AllDay: the v20 tier-count metadata (total_pack_count / total_unopened) is
  // dead-by-design — AllDay mints on demand and RPC never ran the historical
  // PackNFT.Mint walk, so those counters read 0 for every AllDay dist and the
  // pack-content counts render blank/hidden. The authoritative complete mint +
  // opened counts live in v_allday_pack_info (Dapper searchPackNft full-history)
  // — the SAME source the depletion % above already reads (opened_pct_of_minted,
  // passed to the observed-lifecycle strip) — and arrive on the shell bundle as
  // correctedEv. Reconciliation verified live: opened_count <= packnft_total for
  // all AllDay dists (0 violations). Source the counts from it so opened /
  // unopened / total render real numbers.
  const allDayTotalMinted = collection === "nfl-all-day" ? num(correctedEv?.packnft_total) : null
  const allDayOpened = collection === "nfl-all-day" ? num(correctedEv?.opened_count) : null
  const allDayUnopened =
    allDayTotalMinted != null && allDayOpened != null
      ? Math.max(0, allDayTotalMinted - allDayOpened)
      : null
  // Effective figures for the KPI grid + PacksContentRemaining ring: the AllDay
  // authoritative counts win, else the v20 metadata (Top Shot's working path).
  const effectiveTotalMinted = allDayTotalMinted ?? metaTotalPackCount
  const effectiveUnopened = allDayUnopened ?? liveUnopened

  // 2a — Depletion: prefer the v20 metadata-derived figure, fall back to the cached
  // depletion_pct, and HIDE the tile entirely when neither source exists (never 0%).
  const depletionPct: number | null = (() => {
    if (metaTotalPackCount && metaTotalPackCount > 0 && metaTotalUnopened != null) {
      return Math.max(0, Math.min(100, ((metaTotalPackCount - metaTotalUnopened) / metaTotalPackCount) * 100))
    }
    return depletion != null ? Number(depletion) : null
  })()

  // Display-only depletion for the top "Depletion" KPI. AllDay's packs-opened
  // metadata is dead (reads 0), so without this the tile shows a false "0.0%"
  // right beside the authoritative counts + the 89%-opened lifecycle strip.
  // Use the same v_allday_pack_info figure (opened_pct_of_minted, else
  // opened/total). Deliberately SEPARATE from depletionPct so it does NOT feed
  // poolDepletionPct below — that survivor-bias gate must stay pool-based, not
  // packs-opened-based.
  const displayDepletionPct: number | null =
    collection === "nfl-all-day"
      ? (num(correctedEv?.opened_pct_of_minted) != null
          ? Math.max(0, Math.min(100, num(correctedEv?.opened_pct_of_minted)!))
          : allDayTotalMinted != null && allDayTotalMinted > 0 && allDayOpened != null
            ? Math.max(0, Math.min(100, (allDayOpened / allDayTotalMinted) * 100))
            : null)
      : depletionPct

  // Pool depletion (% of the drop pool's editions exhausted) is the figure the
  // pull-value EV is computed against, and the one that drives survivor bias.
  // It is distinct from depletionPct above (% of PACKS opened) — for dists with
  // no pack-open tracking (total_minted/opened = 0) depletionPct reads 0 while
  // the pool is in fact heavily drained, so the survivor-bias caveat must read
  // ev_depletion_pct (straight from pack_ev_latest) or it self-contradicts.
  const poolDepletionPct: number | null =
    merged.ev_depletion_pct != null ? Number(merged.ev_depletion_pct) : depletionPct

  // 2d — EV verdict coverage gate: below 80% FMV coverage the EV is a lower bound,
  // not an authoritative verdict — render it neutral (no red/green) with a caveat.
  const COVERAGE_FLOOR = 80
  const coverageOk = fmvCoverage != null && fmvCoverage >= COVERAGE_FLOOR

  // Item 4 (2026-06-09) — secondary-ask reality check. Pull-value EV is computed
  // over the REMAINING pool, so as a pack sells through (cheap commons exhaust)
  // the surviving chases inflate EV far above what the pack honestly contains. A
  // pack freely listed on secondary for $X can't contain 3×$X of pulls — when it
  // appears to, or the pool is mostly opened, the EV is survivor-biased: render it
  // neutral and surface the secondary ask as the honest value estimate.
  const evInflatedVsAsk = isEvInflatedVsAsk({ secondaryAvailable, secondaryAsk, grossEv })
  const poolMostlyOpened = poolDepletionPct != null && poolDepletionPct >= 60
  // ⚠ A stale snapshot is a THIRD reason the EV must not headline, added
  // 2026-08-15. `+EV` is an affirmative buy signal, and this page published it
  // from whatever `pack_ev_history` last held, however old — the age appeared
  // only as a raw timestamp in the methodology footnote. Measured that day:
  // `compute-pinnacle-pack-ev` had failed every tick since 08-11 (fix committed,
  // undeployed, blocked on an operator secret), leaving Disney Pinnacle's EV
  // 105.9h stale with 42 of 87 dists still flagged `is_positive_ev`. The DEALS
  // surface already excluded them on this same 72h bar; this page did not, so the
  // same stale number was suppressed in one place and headlined in another.
  const evSnapshotStale = isEvSnapshotStale({ snapshottedAt })
  const evUnreliable = showPriceVerdict && (evInflatedVsAsk || poolMostlyOpened || evSnapshotStale)

  const showColoredVerdict = showPriceVerdict && coverageOk && !evUnreliable
  // Egregious survivor bias — the pull-value EV is not merely uncertain but
  // structurally impossible to headline. A depleted TS pack's drop pool retains
  // only the rare chases (packEditionsV3 drops the common tier once sold out —
  // e.g. dist 5223 pools 80 Legendary/Rare editions and ZERO of its 47,300
  // commons), so mean(pooled FMV) overstates a real pull 40–86×. Blank the
  // headline Gross EV / Value-ratio numbers (relegate to a muted "ceiling"
  // caveat) rather than lead with "$801 · 80x · +EV" on a $10 pack. Two triggers:
  // pool ≥90% depleted, or gross EV > 3× a live secondary ask (a number a freely
  // resellable sealed pack provably can't contain). Scoped to the raw TS
  // pull-value path — AllDay's odds-corrected EV carries its own low_confidence
  // caveat and must not be blanked here. See [[pack-ev-view-dataquality-footguns]].
  const evSurvivorBiased = isSurvivorBiased({
    useCorrectedEv,
    hasDropPool,
    depletionPct: poolDepletionPct,
    secondaryAvailable,
    secondaryAsk,
    grossEv,
  })
  const coverageCaveat: string | null = (() => {
    // Staleness is checked FIRST: when the snapshot is days old, "survivor bias"
    // is the wrong explanation to give the reader even if that gate also trips.
    // The age is stated rather than implied — a reader can only judge a stale
    // number if they are told how stale.
    if (showPriceVerdict && evSnapshotStale && snapshottedAt) {
      const hours = Math.floor((Date.now() - Date.parse(snapshottedAt)) / 3_600_000)
      const age = hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hours`
      return `EV last computed ${age} ago — not a current read; treat it as historical`
    }
    if (evUnreliable) {
      const honest = secondaryAvailable && secondaryAsk != null && secondaryAsk > 0
        ? ` honest value ≈ secondary ask ${fmtUsd(secondaryAsk)}`
        : " treat as a ceiling"
      const opened = poolDepletionPct != null ? `${Math.round(poolDepletionPct)}% depleted` : "heavily depleted"
      return `EV inflated by survivor bias (${opened}) —${honest}`
    }
    if (showPriceVerdict && !coverageOk && fmvCoverage != null) {
      return `${fmvCoverage}% FMV cov — EV is a floor`
    }
    return null
  })()

  // One-line summary above the KPI grid. Names the EV anchor explicitly so
  // the user knows whether the verdict is computed against retail or P2P ask.
  // priceSource = 'none' suppresses the verdict entirely.
  const evAnchorSummary: string | null = (() => {
    if (isRewardPack) return "Reward pack — distributed for free, no price-based verdict."
    if (isHoldingPack) return null
    if (secondaryAskAnchor != null) {
      return `Pack EV computed against the live secondary ask [${fmtUsd(secondaryAskAnchor)}] — what a sealed pack actually resells for, the only honest anchor for its value.`
    }
    return "No live secondary ask — showing Gross EV (value still sealed) only, with no net/ratio verdict."
  })()

  // Top Shot pack deep link — nbatopshot.com/?packDetail=<distId> opens the pack
  // detail modal (odds, contents, live "Buy from Market" button) for exactly this
  // dist, including sold-out / legacy drops (verified 2026-07-06). Pack audit S2:
  // suppress the buy CTA on reward packs and when the EV cron determined the pack
  // isn't currently for sale (price_source = "none").
  const buyUrl = collection === "nba-top-shot" && !isRewardPack && priceSource !== "none"
    ? topshotPackUrl({ distId })
    : null
  const buyCtaLabel = priceSource === "primary" || priceSource === "min"
    ? "Buy primary"
    : priceSource === "secondary"
      ? "Buy on secondary market"
      : "Buy on Top Shot"
  // dapper.market per-pack deep link (?packDetail=<distId>) — opens the exact
  // pack's detail modal with a live "Buy Pack" button (verified 2026-07-06). NBA
  // + NFL only; other collections have no packs on dapper.market. Suppressed on
  // reward packs.
  const dapperLeague: "nba" | "nfl" | null =
    collection === "nba-top-shot" ? "nba" : collection === "nfl-all-day" ? "nfl" : null
  const dapperPackUrl = !isRewardPack && dapperLeague
    ? dapperMarketPackUrl({ league: dapperLeague, distId })
    : null

  const tierLabel = humanizeLabel(tier)
  // 7 — the pack_type chip is suppressed when it's just the generic "pack"
  // (it's redundant on a pack page, and rendered tight beside the tier chip it
  // read as "Fandompack"). Only show a meaningful type (box / case / bundle …).
  const rawPackType = String(merged.pack_type ?? "").trim()
  // humanizeLabel, not CSS `capitalize`: underscores aren't word boundaries, so
  // a raw `in_season_premium` rendered as the literal "In_season_premium" on the
  // Golazos pack pages (fixed 2026-07-25).
  const packTypeLabel = rawPackType.toLowerCase() === "pack" ? "" : humanizeLabel(rawPackType)
  // 1d — when slots is unknown render nothing here. The old fallback to
  // packTypeLabel duplicated the pack-type chip beside it ("Pack pack").
  const slotsLabel = merged.slots && merged.slots > 0
    ? `${merged.slots} slot${merged.slots === 1 ? "" : "s"}`
    : null

  const cardStyle: React.CSSProperties = {
    background: "rgba(13,13,13,0.92)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 8,
    padding: 18,
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(packJsonLd({ title, image: merged.image_url, collectionUrlSlug: collection, distId, retailPriceUsd: retailPrice })) }}
      />
      <Breadcrumbs
        items={[
          { name: "Home", href: "/" },
          { name: coll.displayName, href: `/${collection}` },
          { name: title },
        ]}
      />
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section style={cardStyle}>
        <div className="rpc-entity-hero rpc-entity-hero--260">
          <div
            style={{
              width: 260,
              height: 260,
              borderRadius: 6,
              overflow: "hidden",
              background: "rgba(0,0,0,0.4)",
              border: `1px solid ${tierAccent}33`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <PackHeroArt url={merged.image_url} tier={tier} title={title} montage={montageThumbs} size={260} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  letterSpacing: "0.2em",
                  color: "rgba(255,255,255,0.4)",
                  textTransform: "uppercase",
                }}
              >
                {coll.displayName} · Pack #{distId}
              </span>
            </div>
            <h1
              style={{
                margin: 0,
                fontFamily: "var(--font-display)",
                fontWeight: 900,
                fontSize: 32,
                letterSpacing: "0.04em",
                color: "#fff",
                lineHeight: 1.05,
                textTransform: "uppercase",
              }}
            >
              {title}
            </h1>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span
                style={{
                  display: "inline-block",
                  padding: "3px 10px",
                  borderRadius: 4,
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  fontWeight: 700,
                  color: chip.color,
                  background: chip.background,
                  border: chip.border,
                }}
              >
                {tierLabel}
              </span>
              {packTypeLabel && (
                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    color: "rgba(255,255,255,0.7)",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    textTransform: "capitalize",
                  }}
                >
                  {packTypeLabel}
                </span>
              )}
              {slotsLabel && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "rgba(255,255,255,0.55)",
                  }}
                >
                  {slotsLabel}
                </span>
              )}
              {isPositive && grossEv !== null && showPriceVerdict && !evUnreliable && (
                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 700,
                    color: "rgb(110,231,183)",
                    background: "rgba(16,185,129,0.12)",
                    border: "1px solid rgba(16,185,129,0.4)",
                  }}
                >
                  +EV
                </span>
              )}
              {isRewardPack && (
                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 700,
                    color: "rgb(125,211,252)",
                    background: "rgba(14,165,233,0.10)",
                    border: "1px solid rgba(14,165,233,0.40)",
                  }}
                  title="Distributed for free (retail price $0)."
                >
                  Reward pack
                </span>
              )}
              {merged.is_rare_single_pack && (
                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    color: "rgb(252,211,77)",
                    background: "rgba(234,179,8,0.10)",
                    border: "1px solid rgba(234,179,8,0.40)",
                  }}
                  title="EV represents one specific ultra-rare moment rather than a probabilistic pull."
                >
                  Single rare edition
                </span>
              )}
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
              {buyUrl ? (
                <TrackedOutboundLink
                  href={buyUrl}
                  payload={{
                    surface: "pack_dist",
                    destination: "topshot",
                    setName: title,
                    tier,
                    fmv: Number.isFinite(livePrice as number) ? (livePrice as number) : null,
                    buyUrl,
                  }}
                  style={{
                    display: "inline-block",
                    padding: "8px 16px",
                    background: "var(--rpc-red)",
                    color: "#fff",
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    fontSize: 12,
                    borderRadius: 4,
                    textDecoration: "none",
                  }}
                >
                  {buyCtaLabel}
                </TrackedOutboundLink>
              ) : null}
              {dapperPackUrl ? (
                <TrackedOutboundLink
                  href={dapperPackUrl}
                  payload={{
                    surface: "pack_dist",
                    destination: "dapper_market_packs",
                    setName: title,
                    tier,
                    fmv: null,
                    buyUrl: dapperPackUrl,
                  }}
                  style={{
                    display: "inline-block",
                    padding: "8px 16px",
                    background: "transparent",
                    color: "rgba(255,255,255,0.85)",
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    fontSize: 12,
                    borderRadius: 4,
                    border: "1px solid rgba(255,255,255,0.25)",
                    textDecoration: "none",
                  }}
                >
                  Buy on Dapper →
                </TrackedOutboundLink>
              ) : null}
              <PackShareButton url={`${BASE_URL}/${collection}/pack/dist/${encodeURIComponent(distId)}`} />
              <Link
                href={`/${collection}/packs`}
                style={{
                  display: "inline-block",
                  padding: "8px 16px",
                  background: "transparent",
                  color: "rgba(255,255,255,0.7)",
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  fontSize: 12,
                  borderRadius: 4,
                  border: "1px solid rgba(255,255,255,0.2)",
                  textDecoration: "none",
                }}
              >
                ← All packs
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Value still sealed (headline: EV vs pack price) ──────────────── */}
      {/* Vaultopolis-style one-liner: the expected pull value still inside an
          unopened pack (Gross EV) framed against the live pack price. Reuses the
          same colored-verdict + survivor-bias gating as the KPI grid below, so a
          low-coverage / mostly-opened pack reads neutral with the caveat rather
          than over-claiming. Suppressed on reward/holding/no-anchor/no-pool packs. */}
      {showPriceVerdict && !evSurvivorBiased && grossEv !== null && secondaryAskAnchor !== null && secondaryAskAnchor > 0 && hasDropPool && (() => {
        const pctVsPrice = (grossEv / secondaryAskAnchor - 1) * 100
        const above = pctVsPrice >= 0
        const accent = showColoredVerdict
          ? (above ? "rgb(110,231,183)" : "rgb(248,113,113)")
          : "rgba(255,255,255,0.85)"
        const pctLabel = Math.abs(pctVsPrice) >= 1 ? `${Math.round(Math.abs(pctVsPrice))}` : Math.abs(pctVsPrice).toFixed(1)
        return (
          <section
            style={{
              background: "rgba(13,13,13,0.92)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderLeft: `3px solid ${accent}`,
              borderRadius: 6,
              padding: "12px 16px",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "baseline",
              gap: "4px 12px",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,0.45)",
              }}
            >
              Value still sealed
            </span>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 22, color: accent }}>
              ≈ {fmtUsd(grossEv)}
              <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.5)" }}>/pack</span>
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: accent }}>
              {above ? "▲" : "▼"} {pctLabel}% {above ? "above" : "below"} the {fmtUsd(secondaryAskAnchor)} secondary ask
            </span>
            {coverageCaveat ? (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
                · {coverageCaveat}
              </span>
            ) : null}
            {/* Typical Pull framing — a typical pull is worth ~the median moment,
                well below the grail-inflated mean on lottery-shaped packs. */}
            {showTypicalPull && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.55)", width: "100%" }}>
                Typical pull ≈ {fmtUsd(typicalEv)}
                {isLotteryShaped
                  ? ` · grail premium ${fmtUsd(grailPremium)} (lottery-shaped)`
                  : grailPremiumComparable
                    ? " · value evenly spread"
                    : ""}
              </span>
            )}
          </section>
        )
      })()}

      {/* ── EV anchor summary ────────────────────────────────────────────── */}
      {evAnchorSummary && (
        <section
          style={{
            background: "rgba(13,13,13,0.92)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 6,
            padding: "10px 14px",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: isRewardPack || secondaryAskAnchor == null ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.75)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {showPriceVerdict && (
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--rpc-red)",
                flexShrink: 0,
                display: "inline-block",
              }}
            />
          )}
          <span>{evAnchorSummary}</span>
        </section>
      )}

      {/* ── Streamed group (P3): observed lifecycle · EV reality check · what
          drives the remaining EV · sealed-pack resale. Fetched off the shell
          critical path so the connection burst staggers and a slow section
          degrades to nothing instead of timing out the whole page. ── */}
      <Suspense fallback={null}>
        <PackStreamedTop
          collection={collection}
          distId={distId}
          authoritativeDepletionPct={collection === "nfl-all-day" ? num(correctedEv?.opened_pct_of_minted) : null}
        />
      </Suspense>

      {/* ── KPI grid ─────────────────────────────────────────────────────── */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <DualPriceKpi
          primaryPrice={primaryPrice}
          secondaryAsk={secondaryAsk}
          priceSource={priceSource}
          primaryAvailable={primaryAvailable}
          secondaryAvailable={secondaryAvailable}
          fallbackPrice={displayLivePrice}
          retailPrice={displayRetailPrice}
        />
        <KpiCell
          label="Actual EV"
          value={isSentinelEv || isHoldingPack || evSurvivorBiased ? "—" : fmtUsd(grossEv)}
          sub={isHoldingPack ? "Holding pack — not a consumer pack" : isSentinelEv ? "awaiting pool data" : isRewardPack ? "Reward pack — free, no secondary-ask verdict" : evSurvivorBiased ? `≈ ${fmtUsd(grossEv)} ceiling · ${coverageCaveat ?? `pool ${poolDepletionPct != null ? Math.round(poolDepletionPct) + "% depleted" : "heavily depleted"} — survivor-biased`}` : secondaryAskAnchor == null ? "Mean pull value · no live secondary ask" : coverageCaveat ? (packEv !== null ? `Net ${packEv >= 0 ? "+" : "−"}${fmtUsd(Math.abs(packEv))} vs ask · ${coverageCaveat}` : coverageCaveat) : packEv !== null ? `Mean pull · Net ${packEv >= 0 ? "+" : "−"}${fmtUsd(Math.abs(packEv))} vs ask` : undefined}
          color={isSentinelEv || isHoldingPack || evSurvivorBiased || !showColoredVerdict || packEv === null ? undefined : packEv >= 0 ? "rgb(110,231,183)" : "rgb(248,113,113)"}
        />
        {/* Typical Pull EV (2026-07-16) — the value of a typical pull (weighted
            MEDIAN moment × slots), sitting near the common floor. Actual EV (mean)
            overstates lottery-shaped packs where a rare grail is the jackpot; this
            is what most pulls are actually worth. Rendered wherever the pool gives
            us a real median (typical_ev NOT NULL) — including NFL All Day, where
            it used to be suppressed by the corrected-EV override. */}
        {showTypicalPull && (
          <KpiCell
            label="Typical Pull"
            value={fmtUsd(typicalEv)}
            sub={
              isLotteryShaped
                ? `Grail premium ${fmtUsd(grailPremium)} — lottery-shaped`
                : grailPremium != null && grailPremium > 0
                  ? `Grail premium ${fmtUsd(grailPremium)} — value evenly spread`
                  : grailPremiumComparable
                    ? "Median pull ≈ Actual EV — value evenly spread"
                    : "Weighted-median pull value"
            }
          />
        )}
        <KpiCell
          label="Value ratio"
          value={!showPriceVerdict || valueRatio === null || evSurvivorBiased ? "—" : `${valueRatio.toFixed(2)}x`}
          sub={isHoldingPack ? "Holding pack — n/a" : isRewardPack ? "Free pack — n/a" : evSurvivorBiased ? (coverageCaveat ?? "survivor-biased — not meaningful") : priceSource === "none" ? undefined : coverageCaveat ? (evMargin === null ? coverageCaveat : `${fmtPct(evMargin)} margin · ${coverageCaveat}`) : evMargin === null ? undefined : `${fmtPct(evMargin)} margin`}
          color={evSurvivorBiased || !showColoredVerdict || valueRatio === null ? undefined : valueRatio >= 1 ? "rgb(110,231,183)" : "rgb(248,113,113)"}
        />
        <KpiCell
          label="FMV coverage"
          value={fmvCoverage === null ? "—" : `${fmvCoverage}%`}
          sub={editionCount === null ? undefined : `${editionCount} editions`}
        />
        {/* F4 (2026-07-02): reward/quest packs (retail=0) mint-on-demand, so their
            total_minted / total_opened / total_pack_count counters are dead-by-design
            (packs_opened runs ~6× the "minted" figure — e.g. dist 7800: 21k opened vs
            3,240 "minted"). The packs-opened Depletion and "Packs remaining / of N
            minted" KPIs read those dead counters and contradict the honest Observed
            pack lifecycle strip right below. Suppress them for reward packs rather than
            surface a wrong denominator (see [[pack-ev-view-dataquality-footguns]]). */}
        {displayDepletionPct !== null && !isRewardPack && (
          <KpiCell
            label="Depletion"
            value={`${displayDepletionPct.toFixed(displayDepletionPct >= 10 ? 0 : 1)}%`}
            sub={collection === "nfl-all-day" ? "of all minted packs" : tierCountsUpdatedAt ? "live pool" : merged.ev_depletion_pct === null ? undefined : `Pool ${merged.ev_depletion_pct}%`}
          />
        )}
        {!isRewardPack && (
          <KpiCell
            label="Packs remaining"
            value={fmtCount(effectiveUnopened)}
            sub={effectiveTotalMinted !== null ? `of ${fmtCount(effectiveTotalMinted)} minted` : undefined}
          />
        )}
      </section>

      {/* ── AllDay corrected-EV provenance + low-confidence caveat ─────────── */}
      {useCorrectedEv && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.5,
            padding: "10px 12px",
            borderRadius: 8,
            border: `1px solid ${correctedEv!.low_confidence_ev ? "rgba(251,191,36,0.35)" : "rgba(255,255,255,0.12)"}`,
            background: correctedEv!.low_confidence_ev ? "rgba(251,191,36,0.07)" : "rgba(255,255,255,0.03)",
            color: correctedEv!.low_confidence_ev ? "rgb(251,191,36)" : "rgba(255,255,255,0.6)",
          }}
        >
          {correctedEv!.low_confidence_ev && <strong>⚠ Rough estimate. </strong>}
          EV is odds-corrected — tiers valued by median FMV and weighted by{" "}
          {correctedEv!.ev_method === "published_odds" ? "published pack odds" : "circulation share"}
          {" "}(a robust cross-check of the headline supply-weighted EV, resistant to per-edition FMV outliers).
          {correctedEv!.low_confidence_ev && (() => {
            const stale = num(correctedEv!.stale_value_share_pct)
            return stale !== null && stale > 0
              ? ` ~${Math.round(stale)}% of pack value rests on sparse or missing sales data — treat as a rough estimate.`
              : " It rests on thin AllDay FMV — treat as a rough estimate."
          })()}
        </div>
      )}

      {/* ── Packs Content Remaining (Item 1 — TS-style donut + tier bars) ── */}
      {/* F4: null the packs-unopened ring inputs for reward packs — its
          unopened/minted denominator is the dead-by-design counter. The tier
          bars use live pool data (remaining/original by tier) and stay. */}
      <PacksContentRemaining
        unopened={isRewardPack ? null : effectiveUnopened}
        totalMinted={isRewardPack ? null : effectiveTotalMinted}
        remainingByTier={remainingByTier}
        originalByTier={originalByTier}
        updatedAt={tierCountsUpdatedAt}
        hasDropPool={hasDropPool}
        tierAccent={tierAccent}
      />

      {/* ── Pull odds by tier (PACKVIZ 2b) ───────────────────────────────── */}
      <TierOddsPanel
        remainingByTier={remainingByTier}
        originalByTier={originalByTier}
        slots={oddsSlots}
        updatedAt={tierCountsUpdatedAt}
        hasDropPool={hasDropPool}
      />

      {/* ── Top pulls hero strip (PACKVIZ-GRID 2a) ───────────────────────── */}
      {heroEditions.length > 0 && <PackHeroStrip collection={collection} editions={heroEditions} />}

      {/* ── What's Inside (2026-07-25: MOVED OUT of the streamed group) ────
          This grid used to sit inside the bottom <Suspense>, and in production it
          never appeared: the server rendered it correctly and shipped it in the
          tail of the response (verified — the hidden `<div id="S:1">` payload and
          the trailing `$RC("B:1","S:1")` script are both present, in ~1.1 s), but
          the browser never performed the swap, so the page sat on
          the loading skeleton forever, with the real markup sitting inert inside
          `div[hidden]`. A watchdog inside the fallback cannot rescue it either:
          React does not hydrate the fallback of a dehydrated Suspense boundary
          (measured — the fallback <section> carries no React fiber keys while its
          siblings do), so no client code placed there ever runs.

          So the primary content no longer depends on that client-side completion
          step at all: it is read in the shell and ships visible in the initial
          HTML. This is affordable — `get_pack_contents` measured 67 ms for dist
          1599 and ≤731 ms across the 40 largest pools — and it does NOT re-create
          the pre-P3 pool fan-out, because the same read simply moved off the
          streamed group rather than being added (shell 1→2 reads, streamed
          group 4→3). ── */}
      <DegradedDataNotice summary={shellDegraded} />
      <PackContentsSection
        collection={collection}
        distId={distId}
        contents={packContents}
        exhaustedTotal={exhaustedCount}
        fmvCoverage={fmvCoverage}
        editionCount={editionCount}
      />

      {/* ── Streamed group (P3): sales history · top pulls. Genuinely
          supplementary, so `fallback={null}` — same choice as PackStreamedTop.
          A skeleton here is what produced the permanent spinner above; absent is
          honest, an eternal "Loading…" is not. ── */}
      <Suspense fallback={null}>
        <PackStreamedBottom
          collectionId={coll.id}
          distId={distId}
          collection={collection}
          editionCount={editionCount}
          totalUnopened={totalUnopened}
          slots={merged.slots ?? null}
          snapshottedAt={snapshottedAt}
        />
      </Suspense>
    </div>
  )
}

// ── Tiny presentational helpers ────────────────────────────────────────────

function KpiCell({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: 22,
          letterSpacing: "0.02em",
          color: color ?? "#fff",
          marginTop: 4,
        }}
      >
        {value}
      </div>
      {sub ? (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "rgba(255,255,255,0.45)",
            marginTop: 2,
          }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  )
}

function DualPriceKpi({
  primaryPrice,
  secondaryAsk,
  priceSource,
  primaryAvailable,
  secondaryAvailable,
  fallbackPrice,
  retailPrice,
}: {
  primaryPrice: number | null
  secondaryAsk: number | null
  priceSource: "primary" | "secondary" | "min" | "none" | null
  primaryAvailable: boolean
  secondaryAvailable: boolean
  fallbackPrice: number | null
  retailPrice: number | null
}) {
  // Derivation extracted to @/lib/pack-dist-odds (unit-tested there).
  const { legacy, primaryLive, secondaryLive, primaryAnchor, secondaryAnchor } = deriveDualPrice({
    primaryPrice,
    secondaryAsk,
    priceSource,
    primaryAvailable,
    secondaryAvailable,
  })

  // Legacy fallback: when the EV cron hasn't populated the new columns,
  // render the single-line "Pack price" KPI as before.
  if (legacy) {
    return (
      <KpiCell
        label="Pack price"
        value={fmtUsd(fallbackPrice)}
        sub={retailPrice !== null && fallbackPrice !== null && retailPrice !== fallbackPrice ? `Retail ${fmtUsd(retailPrice)}` : undefined}
      />
    )
  }

  const Row = ({
    label,
    value,
    anchor,
    muted,
  }: {
    label: string
    value: string
    anchor: boolean
    muted: boolean
  }) => (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6, lineHeight: 1.25 }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
          minWidth: 64,
          display: "inline-block",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: anchor ? 800 : 600,
          fontSize: 18,
          letterSpacing: "0.02em",
          fontVariantNumeric: "tabular-nums",
          color: anchor ? "var(--rpc-red)" : muted ? "rgba(255,255,255,0.45)" : "#fff",
        }}
      >
        {value}
      </span>
      {anchor && (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--rpc-red)",
            display: "inline-block",
            flexShrink: 0,
          }}
        />
      )}
    </div>
  )

  return (
    <div
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
          marginBottom: 6,
        }}
      >
        Pack price
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Row
          label="Primary"
          value={primaryLive ? fmtUsd(primaryPrice) : "SOLD OUT"}
          anchor={primaryAnchor && primaryLive}
          muted={!primaryLive}
        />
        <Row
          label="Secondary"
          value={secondaryLive ? fmtUsd(secondaryAsk) : "—"}
          anchor={secondaryAnchor && secondaryLive}
          muted={!secondaryLive}
        />
      </div>
    </div>
  )
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        textAlign: align,
        padding: "8px 10px",
        fontSize: 9,
        letterSpacing: "0.15em",
        textTransform: "uppercase",
        color: "rgba(255,255,255,0.45)",
        fontWeight: 700,
      }}
    >
      {children}
    </th>
  )
}

function Td({ children, align = "left", color }: { children: React.ReactNode; align?: "left" | "right"; color?: string }) {
  return (
    <td
      style={{
        textAlign: align,
        padding: "8px 10px",
        color: color ?? "rgba(255,255,255,0.85)",
      }}
    >
      {children}
    </td>
  )
}

// ── Top pulls hero strip (PACKVIZ-GRID 2a) ──────────────────────────────────
// The "what am I chasing" view: the 5 highest-FMV pullable editions, bigger
// art + FMV + hit% chip, in a horizontally-scrolling strip above the grid.

function PackHeroStrip({ collection, editions }: { collection: string; editions: HeroEdition[] }) {
  return (
    <section
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
        padding: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: "0.06em",
            color: "#fff",
            textTransform: "uppercase",
          }}
        >
          Top chases
        </h2>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          highest-FMV pulls in this pack
        </span>
      </div>
      <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
        {editions.map((e, i) => {
          const chip = tierChip(String(e.tier ?? "common"))
          const hitPct = e.hit_probability != null && Number.isFinite(e.hit_probability)
            ? `${(e.hit_probability * 100).toFixed(2)}%`
            : null
          const inner = (
            <>
              <div
                style={{
                  width: "100%",
                  aspectRatio: "1 / 1",
                  borderRadius: 4,
                  overflow: "hidden",
                  background: "rgba(0,0,0,0.4)",
                  marginBottom: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {tsTileImg(collection, e.rep_nft_id, e.thumbnail_url) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={tsTileImg(collection, e.rep_nft_id, e.thumbnail_url) as string}
                    alt={e.player_name ?? "Edition"}
                    loading={i < 5 ? "eager" : "lazy"}
                    decoding="async"
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                ) : (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "rgba(255,255,255,0.35)" }}>No image</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                <span
                  style={{
                    display: "inline-block",
                    padding: "1px 6px",
                    borderRadius: 3,
                    fontSize: 9,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    color: chip.color,
                    background: chip.background,
                    border: chip.border,
                  }}
                >
                  {String(e.tier ?? "—").charAt(0).toUpperCase() + String(e.tier ?? "").slice(1).toLowerCase()}
                </span>
                {hitPct && (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "rgba(255,255,255,0.5)" }}>
                    Hit {hitPct}
                  </span>
                )}
              </div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, color: "#fff", lineHeight: 1.15 }}>
                {e.player_name ?? "Unknown"}
              </div>
              {e.set_name && (
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "rgba(255,255,255,0.5)", marginTop: 1 }}>
                  {e.set_name}
                </div>
              )}
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16, color: "var(--rpc-red)", marginTop: 4 }}>
                {fmtUsd(e.fmv_usd)}
              </div>
            </>
          )
          const cardStyleStrip: React.CSSProperties = {
            flex: "0 0 auto",
            width: 150,
            textDecoration: "none",
            color: "inherit",
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 6,
            padding: 10,
          }
          return e.route_slug ? (
            <Link key={e.route_slug + i} href={`/${collection}/edition/${encodeURIComponent(e.route_slug)}`} style={cardStyleStrip}>
              {inner}
            </Link>
          ) : (
            <div key={i} style={cardStyleStrip}>{inner}</div>
          )
        })}
      </div>
    </section>
  )
}

// ── Pull odds by tier (PACKVIZ 2b) ──────────────────────────────────────────
// Top Shot's own pack pages lead with per-tier hit chances; RPC now has the data
// (compute-topshot-pack-ev v20 persists remaining/original counts-by-tier into
// pack_distributions.metadata). Renders only when those counts are present, so it
// fills in per pack as the v20 EV sweep reaches it.

// TIER_RARITY_ORDER + pull-odds math extracted to @/lib/pack-dist-odds (unit-tested there).

// relTimeShort extracted to @/lib/pack-dist-format (imported below).

// `poolRemaining` is the total number of remaining POOL ENTRIES (Σ over tiers
// of remaining_by_tier), NOT packs-remaining. Dividing by packs-remaining was
// the Pack 1a bug (Common showed 596% = 328 entries / 55 packs).
// packOddsLabel extracted to @/lib/pack-dist-format (imported below).

function TierOddsPanel({
  remainingByTier,
  originalByTier,
  slots,
  updatedAt,
  hasDropPool,
}: {
  remainingByTier: Record<string, number> | null
  originalByTier: Record<string, number> | null
  slots: number | null
  updatedAt: string | null
  hasDropPool: boolean
}) {
  if (!remainingByTier || !originalByTier) return null
  // 1b — On no-pool packs the v20 metadata writes pack-count-by-tier here, not
  // pool entries, so the percentages and odds would be fabricated. Only render
  // when there's a real indexed drop pool; the Top-Pulls empty state covers
  // the rest.
  if (!hasDropPool) return null
  // 1a — denominator is the remaining POOL ENTRIES across all tiers.
  const poolRemaining = sumPoolRemaining(remainingByTier)
  const tiers = orderedTiersWithSupply(originalByTier)
  if (tiers.length === 0) return null

  return (
    <section
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
        padding: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: "0.06em",
            color: "#fff",
            textTransform: "uppercase",
          }}
        >
          Pull odds by tier
        </h2>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          {slots && slots > 0 ? `${slots} slots/pack` : "per pack"}
          {updatedAt ? ` · as of ${relTimeShort(updatedAt)}` : ""}
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              <Th>Tier</Th>
              <Th align="right">Remaining</Th>
              <Th align="right">% of pool</Th>
              <Th align="right">Odds / pack</Th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => {
              const remaining = Number(remainingByTier[t] ?? 0)
              const original = Number(originalByTier[t] ?? 0)
              const chip = tierChip(t)
              return (
                <tr key={t} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  <Td>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "2px 8px",
                        borderRadius: 4,
                        fontSize: 10,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        fontWeight: 700,
                        color: chip.color,
                        background: chip.background,
                        border: chip.border,
                      }}
                    >
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </span>
                  </Td>
                  <Td align="right" color="rgba(255,255,255,0.85)">
                    {remaining.toLocaleString()} <span style={{ color: "rgba(255,255,255,0.4)" }}>/ {original.toLocaleString()}</span>
                  </Td>
                  <Td align="right" color="rgba(255,255,255,0.6)">
                    {pctOfPoolLabel(remaining, poolRemaining)}
                  </Td>
                  <Td align="right" color={remaining > 0 ? "#fff" : "rgba(255,255,255,0.4)"}>
                    {packOddsLabel(remaining, poolRemaining, slots)}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
        Odds/pack ≈ chance of at least one card of that tier across {slots && slots > 0 ? slots : "the"} slots, from the live remaining pool. Approximate (assumes independent slots).
      </div>
    </section>
  )
}

// ── Packs Content Remaining (Item 1) ────────────────────────────────────────
// Top Shot's drop pages lead with a "Packs Content Remaining" module: a ring of
// packs still unopened + per-tier remaining bars. RPC now has the same data
// (compute-topshot-pack-ev v20 persists remaining/original counts-by-tier +
// total_unopened/total_pack_count into pack_distributions.metadata). Renders
// only when there's a real indexed drop pool AND at least one of the two data
// sources (packs ring / tier bars) is present — never fabricates bars on a
// no-pool pack (same gate as TierOddsPanel, Pack 1b).

function PacksContentRemaining({
  unopened,
  totalMinted,
  remainingByTier,
  originalByTier,
  updatedAt,
  hasDropPool,
  tierAccent,
}: {
  unopened: number | null
  totalMinted: number | null
  remainingByTier: Record<string, number> | null
  originalByTier: Record<string, number> | null
  updatedAt: string | null
  hasDropPool: boolean
  tierAccent: string
}) {
  if (!hasDropPool) return null
  const hasRing = totalMinted != null && totalMinted > 0 && unopened != null
  const hasBars = !!remainingByTier && !!originalByTier
  if (!hasRing && !hasBars) return null

  // Donut: fraction of minted packs still unopened. conic-gradient ring with a
  // hollow center label, no chart lib (the artifact-brand-CSS pattern).
  const unopenedPct = hasRing ? Math.max(0, Math.min(100, (unopened! / totalMinted!) * 100)) : null
  const ring = unopenedPct != null
    ? `conic-gradient(${tierAccent} 0 ${unopenedPct}%, rgba(255,255,255,0.08) ${unopenedPct}% 100%)`
    : undefined

  const tiers = hasBars ? orderedTiersWithSupply(originalByTier!) : []

  return (
    <section
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
        padding: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 14 }}>
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: "0.06em",
            color: "#fff",
            textTransform: "uppercase",
          }}
        >
          Packs Content Remaining
        </h2>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          live pool{updatedAt ? ` · as of ${relTimeShort(updatedAt)}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
        {ring && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
            <div
              style={{
                position: "relative",
                width: 132,
                height: 132,
                borderRadius: "50%",
                background: ring,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div
                style={{
                  width: 92,
                  height: 92,
                  borderRadius: "50%",
                  background: "rgba(13,13,13,0.98)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 2,
                }}
              >
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 24, color: "#fff", lineHeight: 1 }}>
                  {unopenedPct!.toFixed(unopenedPct! >= 10 ? 0 : 1)}%
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)" }}>
                  unopened
                </span>
              </div>
            </div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.7)" }}>
              {fmtCount(unopened)} / {fmtCount(totalMinted)} packs
            </span>
          </div>
        )}

        {tiers.length > 0 && (
          <div style={{ flex: "1 1 280px", minWidth: 240, display: "flex", flexDirection: "column", gap: 10 }}>
            {tiers.map((t) => {
              const remaining = Number(remainingByTier![t] ?? 0)
              const original = Number(originalByTier![t] ?? 0)
              const pct = original > 0 ? Math.max(0, Math.min(100, (remaining / original) * 100)) : 0
              const chip = tierChip(t)
              return (
                <div key={t}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: chip.color, letterSpacing: "0.04em", textTransform: "uppercase", fontWeight: 700 }}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.7)" }}>
                      {remaining.toLocaleString()} <span style={{ color: "rgba(255,255,255,0.4)" }}>/ {original.toLocaleString()} ({pct.toFixed(pct >= 10 ? 0 : 1)}%)</span>
                    </span>
                  </div>
                  <div style={{ height: 8, borderRadius: 4, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: chip.color, borderRadius: 4 }} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

// ── Pack Sales History (Item 2) ─────────────────────────────────────────────
// Top Purchases (highest price) + Recent Purchases (newest). Buyer renders as a
// short wallet linking to /analytics/wallets/<addr> — the differentiator over
// Top Shot's own drop page, where the buyer is a dead-end name. Coverage is
// partial (the dist bridge only links sales whose pack was later opened), so
// the module carries an explicit caption and an honest empty state.

// fmtSalePrice extracted to @/lib/pack-dist-format (imported below).

function ShortWallet({ address, name }: { address: string | null; name?: string | null }) {
  if (!address) return <span style={{ color: "rgba(255,255,255,0.4)" }}>—</span>
  const trunc = address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
  return (
    <Link
      href={`/analytics/wallets/${address.toLowerCase()}`}
      title={name ? `${name} · ${address}` : address}
      style={{ color: "#fff", textDecoration: "none", borderBottom: "1px dotted rgba(255,255,255,0.25)" }}
    >
      {name ? `@${name}` : trunc}
    </Link>
  )
}

function PackSalesTable({ title, rows, names }: { title: string; rows: PackSaleRow[]; names: Map<string, string> }) {
  return (
    <div style={{ flex: "1 1 320px", minWidth: 280 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)", marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              <Th>Buyer</Th>
              <Th align="right">Sale price</Th>
              <Th align="right">When</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr key={`${s.tx_hash ?? i}-${title}`} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <Td><ShortWallet address={s.buyer_address} name={s.buyer_address ? names.get(s.buyer_address.toLowerCase()) ?? null : null} /></Td>
                <Td align="right">{fmtSalePrice(s.sale_price)}</Td>
                <Td align="right" color="rgba(255,255,255,0.55)">
                  <span title={s.sealed_at ? new Date(s.sealed_at).toLocaleString() : undefined}>{relTimeShort(s.sealed_at)}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PackSalesHistory({ rows, names }: { rows: PackSaleRow[]; names: Map<string, string> }) {
  const top = rows.filter((r) => r.kind === "top")
  const recent = rows.filter((r) => r.kind === "recent")

  return (
    <section
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
        padding: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: "0.06em",
            color: "#fff",
            textTransform: "uppercase",
          }}
        >
          Sales History
        </h2>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          secondary pack sales
        </span>
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.35)", marginBottom: 14 }}>
        Traced via opened packs — partial coverage that grows over time. Buyer links open the wallet&apos;s full intelligence.
      </div>

      {rows.length === 0 ? (
        <div
          style={{
            padding: "12px 14px",
            border: "1px dashed rgba(255,255,255,0.1)",
            borderRadius: 6,
            color: "rgba(255,255,255,0.4)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
          }}
        >
          No traced sales yet for this pack.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          {top.length > 0 && <PackSalesTable title="Top purchases" rows={top} names={names} />}
          {recent.length > 0 && <PackSalesTable title="Recent purchases" rows={recent} names={names} />}
        </div>
      )}
    </section>
  )
}

// ── P3: streamed section groups ─────────────────────────────────────────────
// Fetched off the shell critical path (the shell renders from get_pack_detail_bundle
// alone). Grouped into two async components — one per DOM position — so the heavy
// queries never block first paint and a slow one degrades to nothing/skeleton
// instead of timing out the whole page under connection-pool pressure.

// The visual "What's Inside" grid, rendered in the SHELL (2026-07-25) so it is
// present and visible in the initial HTML instead of depending on a client-side
// Suspense completion that production demonstrably never performs.
//
// `contents === null` means the read FAILED and `[]` means the pool is genuinely
// unindexed — they get different copy. Collapsing both to "render nothing" is
// what previously deleted this whole panel silently whenever the RPC errored.
function PackContentsSection({
  collection,
  distId,
  contents,
  exhaustedTotal,
  fmvCoverage,
  editionCount,
}: {
  collection: string
  distId: string
  contents: EditionTile[] | null
  exhaustedTotal: number
  fmvCoverage: number | null
  editionCount: number | null
}) {
  if (contents === null) {
    return (
      <section style={{ ...CARD_STYLE, fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.55)" }}>
        Couldn&apos;t load this pack&apos;s contents. The rest of the page is accurate — only this
        panel is missing. Reload to try again.
      </section>
    )
  }
  if (contents.length === 0) return null

  return (
    <section style={CARD_STYLE}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, letterSpacing: "0.06em", color: "#fff", textTransform: "uppercase" }}>
          What&apos;s Inside
        </h2>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          {fmvCoverage !== null && editionCount
            ? `FMV priced ${fmtCount(Math.round((fmvCoverage / 100) * editionCount))} of ${editionCount} (${fmvCoverage}%)`
            : editionCount ? `${editionCount} editions in pool` : "pullable editions"}
        </span>
      </div>
      <EditionsGridPaginated
        collectionUrlSlug={collection}
        fetchUrl={`/api/entity/pack?collection=${encodeURIComponent(collection)}&dist_id=${encodeURIComponent(distId)}`}
        initial={contents}
        pageSize={PACK_CONTENTS_PAGE_SIZE}
        showSetLink
        showSort
        packMode
        exhaustedTotal={exhaustedTotal}
      />
    </section>
  )
}

// Top group: observed lifecycle · EV reality check · what drives the remaining EV
// · sealed-pack resale. (All conditional/supplementary — fallback={null}.)
async function PackStreamedTop({
  collection,
  distId,
  authoritativeDepletionPct,
}: {
  collection: string
  distId: string
  authoritativeDepletionPct: number | null
}) {
  const [lifecycleRes, realizedEvRes, evContributorsRes, packMarketRes] = await Promise.all([
    fetchPackLifecycle(collection, distId),
    fetchPackRealizedEv(collection, distId),
    fetchEvContributors(collection, distId),
    fetchPackMarket(collection, distId),
  ])
  const lifecycle = lifecycleRes.data
  const realizedEv = realizedEvRes.data
  const evContributors = evContributorsRes.rows
  const packMarket = packMarketRes.data
  // Every panel in this group SELF-HIDES when its data is absent, so a failed
  // read is indistinguishable from "this pack has no opens / no resale history"
  // — the reader sees a shorter page and no reason for it. The notice is the
  // only thing that separates those two. A section that does not apply to this
  // collection reports ok:true (see the fetchers' module header), so this never
  // fires merely because a Top-Shot-only panel is absent on an All Day pack.
  const streamedTopDegraded = summarizeDegraded([
    boardStatus("Observed lifecycle", lifecycleRes.ok),
    boardStatus("EV reality check", realizedEvRes.ok),
    boardStatus("What drives the remaining EV", evContributorsRes.ok),
    boardStatus("Sealed-pack resale", packMarketRes.ok),
  ])

  // Observed lifecycle
  const lcOpened = num(lifecycle?.packs_opened)
  const lcConfirmed = num(lifecycle?.packs_opened_confirmed)
  const lcInferred = num(lifecycle?.packs_opened_inferred)
  const lcSealed = num(lifecycle?.packs_sealed_observed)
  const lcMoments = num(lifecycle?.moments_pulled)
  const lcRealizedTotal = num(lifecycle?.realized_pull_value_usd)
  const lcAvgPerPack = num(lifecycle?.avg_realized_value_per_pack)
  const lcDepletion = authoritativeDepletionPct ?? num(lifecycle?.observed_depletion_pct)
  const lcDepletionAuthoritative = authoritativeDepletionPct !== null
  const showLifecycle = lcOpened !== null && lcOpened > 0
  const lcInferredOnly = (lcConfirmed ?? 0) === 0 && (lcInferred ?? 0) > 0
  // TS + AllDay pack-open history is reconstructed to genesis via the Dapper
  // searchPackNft registry (complete). Golazos/Pinnacle remain on-chain-window only.
  // AllDay's v_allday_pack_lifecycle count is complete (on-chain open ingest).
  // Top Shot's get_pack_lifecycle_row counts only opens ATTRIBUTED to this dist via
  // the pack_rips bridge (partial: ~20% and growing) — NOT the complete open history,
  // which lives in the supply counters shown in the KPI row above (total_opened /
  // Depletion). Label the TS number as the sample it is so it never contradicts them.
  const lcSince = collection === "nfl-all-day" ? "complete open history" : "attributed rips · sample"

  // Modeled-vs-realized reality check
  const reModeled = num(realizedEv?.modeled_gross_ev)
  const reOpens = num(realizedEv?.n_opens)
  const reMean = num(realizedEv?.realized_mean)
  const reMedian = num(realizedEv?.realized_median)
  const reP90 = num(realizedEv?.realized_p90)
  const reRatio = num(realizedEv?.realized_to_modeled_ratio)
  const reCalibrated = num(realizedEv?.calibrated_ev)
  // Modeled gross EV is NULL when the pool can't be honestly priced (sentinel row) —
  // still show the panel on the realized pull distribution alone (it's the more
  // trustworthy number anyway), just without the modeled-vs-actual comparison.
  const hasModeled = reModeled !== null && reModeled > 0
  const showRealizedEv =
    reMean !== null && reOpens !== null && reOpens >= 10
  const showCalibrated = computeShowCalibrated(hasModeled, reCalibrated, reModeled)
  const reVerdict = deriveRealizedVsModeledVerdict(reRatio)

  // EV contributors (Top Shot)
  const showEvContributors = collection === "nba-top-shot" && evContributors.length > 0
  const evContributorsLowConfShare = computeEvContributorsLowConfShare(evContributors)

  // Sealed-pack resale market
  const pmSales = num(packMarket?.n_sales)
  const pmSales90 = num(packMarket?.n_sales_90d)
  const pmMedian90 = num(packMarket?.median_price_90d)
  const pmLast = num(packMarket?.last_sale_price)
  const pmLastAt = packMarket?.last_sale_at ?? null
  const pmRetail = num(packMarket?.retail_price)
  const pmRatio = num(packMarket?.secondary_vs_retail_ratio)
  const showPackMarket = pmSales !== null && pmSales > 0 && (pmMedian90 !== null || pmLast !== null)
  const pmVerdict = deriveSealedResaleVerdict(pmRatio)

  return (
    <>
      <DegradedDataNotice summary={streamedTopDegraded} />
      {showLifecycle && (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)" }}>
            Observed pack lifecycle
          </span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            <KpiCell
              label="Packs opened"
              value={fmtCount(lcOpened)}
              sub={
                lcInferredOnly
                  ? `${lcSince} · inferred`
                  : lcInferred != null && lcInferred > 0 && lcConfirmed != null
                    ? `${lcSince} · ${fmtCount(lcConfirmed)} confirmed`
                    : lcSince
              }
            />
            <KpiCell label="Moments pulled" value={fmtCount(lcMoments)} sub="from opened packs" />
            {/* Both are NULL (-> em dash) when no attributed rip carries a priced
                pull. They used to be COALESCE'd to 0 in the DB, so 534 of the
                1,612 Top Shot dists with observed opens printed a FABRICATED
                "$0.00 realized" beside a real pull count — the absent-rendered-as-
                zero class. Fixed in
                audit_20260801_pack_lifecycle_realized_value_never_fabricate_zero;
                a genuine measured 0.00 (269 dists) still shows as $0.00. */}
            <KpiCell label="Realized pull value" value={fmtUsd(lcRealizedTotal)} sub="total, priced pulls" />
            <KpiCell label="Avg / pack" value={fmtUsd(lcAvgPerPack)} sub="per pack we could price" />
            {lcSealed != null && lcSealed > 0 && (
              <KpiCell label="Sealed (observed)" value={fmtCount(lcSealed)} sub="still unopened" />
            )}
            {lcDepletion != null && lcDepletionAuthoritative && (
              <KpiCell
                label="Opened share"
                value={`${lcDepletion.toFixed(lcDepletion >= 10 ? 0 : 1)}%`}
                sub="of all minted packs"
              />
            )}
          </div>
        </section>
      )}

      {showRealizedEv && (
        <section style={{ background: "rgba(13,13,13,0.92)", border: "1px solid rgba(255,255,255,0.06)", borderLeft: `3px solid ${reVerdict?.accent ?? "rgba(255,255,255,0.2)"}`, borderRadius: 6, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)" }}>
            {hasModeled ? "EV reality check" : "Realized pull value"}
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 14px" }}>
            {hasModeled && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
                Modeled <strong style={{ color: "rgba(255,255,255,0.9)" }}>{fmtUsd(reModeled)}</strong>/pack
              </span>
            )}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: reVerdict?.accent ?? "rgba(255,255,255,0.85)" }}>
              {hasModeled ? "vs realized " : "Realized "}<strong>{fmtUsd(reMean)}</strong> avg
              {reMedian != null ? ` · ${fmtUsd(reMedian)} median` : ""}
              {reP90 != null ? ` · ${fmtUsd(reP90)} p90` : ""}
            </span>
            {reRatio != null && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: reVerdict?.accent ?? "rgba(255,255,255,0.85)" }}>
                ({reRatio.toFixed(2)}×)
              </span>
            )}
          </div>
          {showCalibrated && (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 10px" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.9)" }}>
                Calibrated estimate <strong style={{ color: "rgb(250,204,21)" }}>{fmtUsd(reCalibrated)}</strong>/pack
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
                model blended toward observed pulls
              </span>
            </div>
          )}
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
            {reVerdict?.label ?? "Realized pull value"} · {fmtCount(reOpens)} attributed opens
          </span>
        </section>
      )}

      {showEvContributors && (
        <section style={CARD_STYLE}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, letterSpacing: "0.06em", color: "#fff", textTransform: "uppercase" }}>
              What drives the remaining EV
            </h2>
          </div>
          <p style={{ margin: "0 0 10px", color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.5 }}>
            Each row is an edition still in the pool. EV share = pull odds × FMV as a fraction of the pack per-slot
            expected value — what the remaining contents are actually worth.
          </p>
          {evContributorsLowConfShare >= 25 && (
            <p style={{ margin: "0 0 10px", color: "rgb(252,211,77)", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.5 }}>
              ⚠ {Math.round(evContributorsLowConfShare)}% of the remaining EV leans on thinly-traded chase prices — treat it as soft.
            </p>
          )}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <Th>Edition</Th>
                  <Th>Tier</Th>
                  <Th align="right">Pull %</Th>
                  <Th align="right">FMV</Th>
                  <Th align="right">EV share</Th>
                </tr>
              </thead>
              <tbody>
                {evContributors.map((c) => {
                  const pull = num(c.pull_prob)
                  const evShare = num(c.pct_of_ev)
                  return (
                    <tr key={c.edition_id} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                      <Td>
                        {c.external_id ? (
                          <Link href={`/${collection}/edition/${encodeURIComponent(c.external_id)}`} style={{ color: "#fff", textDecoration: "none" }}>
                            {c.player_name || "—"}
                          </Link>
                        ) : (
                          <span style={{ color: "#fff" }}>{c.player_name || "—"}</span>
                        )}
                        <span style={{ color: "rgba(255,255,255,0.4)" }}> · {c.set_name || "—"}</span>
                      </Td>
                      <Td color={c.tier ? tierChip(String(c.tier)).color : undefined}>
                        {c.tier ? String(c.tier).charAt(0).toUpperCase() + String(c.tier).slice(1) : "—"}
                      </Td>
                      <Td align="right">{pull === null ? "—" : `${(pull * 100).toFixed(2)}%`}</Td>
                      <Td align="right">{fmtUsd(num(c.fmv_usd))}</Td>
                      <Td align="right">{evShare === null ? "—" : `${evShare.toFixed(1)}%`}</Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
            EV share = pull odds × FMV ÷ per-slot EV, over the editions remaining in the pool.
          </div>
        </section>
      )}

      {showPackMarket && (
        <section style={{ background: "rgba(13,13,13,0.92)", border: "1px solid rgba(255,255,255,0.06)", borderLeft: `3px solid ${pmVerdict?.accent ?? "rgba(255,255,255,0.2)"}`, borderRadius: 6, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)" }}>
            Sealed pack resale
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 14px" }}>
            {pmMedian90 !== null && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
                Median <strong style={{ color: "rgba(255,255,255,0.9)" }}>{fmtUsd(pmMedian90)}</strong>
                <span style={{ color: "rgba(255,255,255,0.4)" }}> (90d)</span>
              </span>
            )}
            {pmLast !== null && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
                Last <strong style={{ color: "rgba(255,255,255,0.9)" }}>{fmtUsd(pmLast)}</strong>
                {fmtAgo(pmLastAt) ? <span style={{ color: "rgba(255,255,255,0.4)" }}> · {fmtAgo(pmLastAt)}</span> : null}
              </span>
            )}
            {pmRetail !== null && pmRetail > 0 && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
                Retail {fmtUsd(pmRetail)}
              </span>
            )}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
              {fmtCount(pmSales)} sale{pmSales === 1 ? "" : "s"}
              {pmSales90 !== null && pmSales90 > 0 ? ` · ${fmtCount(pmSales90)} in 90d` : ""}
            </span>
          </div>
          {pmVerdict && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: pmVerdict.accent }}>
              {pmVerdict.label}
            </span>
          )}
        </section>
      )}
    </>
  )
}

// Bottom group: sales history · what's inside grid · top pulls by EV.
async function PackStreamedBottom({
  collectionId,
  distId,
  collection,
  editionCount,
  totalUnopened,
  slots,
  snapshottedAt,
}: {
  collectionId: string
  distId: string
  collection: string
  editionCount: number | null
  totalUnopened: number | null
  slots: number | null
  snapshottedAt: string | null
}) {
  const [salesRes, topPullsRes] = await Promise.all([
    fetchPackSalesHistory(collectionId, distId, 10),
    fetchTopPulls(collectionId, distId, totalUnopened, slots),
  ])
  const salesHistory = salesRes.rows
  const topPulls = topPullsRes.rows
  const bottomDegraded = summarizeDegraded([
    boardStatus("Sealed-pack sales history", salesRes.ok),
    { label: "Top pulls by EV", ok: topPullsRes.ok, partial: topPullsRes.partial },
  ])

  const packSaleNames = await resolveUsernames(
    salesHistory.flatMap((s) => [s.buyer_address, s.seller_address]).filter((a): a is string => !!a),
  )

  return (
    <>
      <DegradedDataNotice summary={bottomDegraded} />
      <PackSalesHistory rows={salesHistory} names={packSaleNames} />

      <section style={CARD_STYLE}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, letterSpacing: "0.06em", color: "#fff", textTransform: "uppercase" }}>
            Top pulls by EV
          </h2>
          {/* ⚠ Both of these used to key on `topPulls.length === 0` alone, and
              fetchTopPulls returned [] on a query error — so a statement timeout
              rendered "aren't indexed for this distribution yet", a claim about
              OUR INDEX manufactured from OUR outage, on a pack whose pool is in
              fact fully indexed. Branch on `ok` first; an empty result is only
              "unindexed" when we actually managed to ask. */}
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
            {!topPullsRes.ok
              ? "unavailable"
              : topPulls.length === 0
                ? "no pool rows"
                : `top ${topPulls.length} of ${editionCount ?? "?"}`}
          </span>
        </div>
        {!topPullsRes.ok ? (
          <div style={{ padding: "12px 14px", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 6, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
            Couldn&apos;t load this pack&apos;s drop pool. This says nothing about whether the pool is
            indexed — only that the read failed. Reload to try again.
          </div>
        ) : topPulls.length === 0 ? (
          <div style={{ padding: "12px 14px", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 6, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
            Drop-pool contents aren&apos;t indexed for this distribution yet. Older/depleted packs are re-pooled from Dapper Atlas remaining-count data as that harvest runs.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <Th>Player</Th>
                  <Th>Set</Th>
                  <Th>Tier</Th>
                  <Th align="right">Drop %</Th>
                  <Th align="right">FMV</Th>
                  <Th align="right">Edition EV</Th>
                </tr>
              </thead>
              <tbody>
                {topPulls.map((p) => (
                  <tr key={p.editionId} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                    <Td>
                      {p.externalId ? (
                        <Link href={`/${collection}/edition/${encodeURIComponent(p.externalId)}`} style={{ color: "#fff", textDecoration: "none" }}>
                          {p.player}
                        </Link>
                      ) : (
                        <span style={{ color: "#fff" }}>{p.player}</span>
                      )}
                    </Td>
                    <Td color="rgba(255,255,255,0.6)">{p.setName || "—"}</Td>
                    <Td color={p.tier ? tierChip(String(p.tier)).color : undefined}>{p.tier ? String(p.tier).charAt(0).toUpperCase() + String(p.tier).slice(1) : "—"}</Td>
                    <Td align="right">{p.probabilityPct === null ? "—" : `${p.probabilityPct.toFixed(2)}%`}</Td>
                    <Td align="right">{fmtUsd(p.fmvUsd)}</Td>
                    <Td align="right" color={p.editionEv !== null && p.editionEv > 0 ? "rgb(110,231,183)" : undefined}>
                      {fmtUsdEv(p.editionEv)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
          Edition EV = FMV × (drop_weight / pool_weight) × slots. Sums to Gross EV over the full pool. Snapshotted{" "}
          {snapshottedAt ? new Date(snapshottedAt).toLocaleString() : "—"}. Methodology: cached pack_ev_history via the
          compute-pack-ev edge function.
        </div>
      </section>
    </>
  )
}

// Rendered when get_pack_detail_bundle could not be READ — distinct from a dist
// that does not exist (that still 404s). Replaces a deliberate `throw` whose
// error boundary never ran on this ISR route.
function PackUnavailable({ collection }: { collection: string }) {
  return (
    <main style={{ minHeight: "60vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", gap: 16 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        Pack unavailable
      </div>
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "clamp(26px, 5vw, 42px)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0, textAlign: "center" }}>
        Couldn&rsquo;t load this pack
      </h1>
      <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 520, textAlign: "center", margin: 0, lineHeight: 1.5 }}>
        The pack data didn&rsquo;t come back in time, so nothing is shown rather than a partial view.
        This is a problem on our side &mdash; it does not mean the pack is gone or sold out. Reloading often works.
      </p>
      <a href={`/${collection}/packs`} style={{ marginTop: 8, padding: "10px 18px", border: "1px solid var(--rpc-red-border)", color: "var(--rpc-red)", background: "transparent", fontFamily: "var(--font-mono)", letterSpacing: "0.2em", textTransform: "uppercase", fontSize: 12, textDecoration: "none" }}>
        All packs
      </a>
    </main>
  )
}
