// lib/moment-detail-seo.ts
//
// Pure SEO / display derivations lifted out of app/moment/[id]/page.tsx so their
// branch logic is unit-tested rather than trapped inline in a 1,900-line server
// component. Each function is a byte-for-byte lift of the inline block it
// replaces — the page imports these and passes the same inputs, so behavior is
// unchanged; the only difference is these paths now have direct test coverage.
//
// These matter because they gate SEO-visible output: a wrong Product JSON-LD
// price gets indexed by Google, a broken canonical splits ranking between two
// URLs, and the hero-image candidate list is the fix for the "~30% blank black
// hero on legacy Series 1-4 Top Shot moments" regression.

import { fromDbSlug } from "@/lib/collections"
import { proxyIpfsUrl } from "@/lib/ipfs-media"
import { joinMetaParts, metaField } from "@/lib/format"

// Deterministic hero badges for the current serial that the
// special_serial_holders sweep may not have populated (#1 + the perfect serial
// #N/N). Only #1 / Perfect Serial are derived here (Jersey Match comes from the
// sweep). Deduped against the labels already shown so the hero never doubles up.
// Returns [] for an edition-level page (serial == null).
export function deriveSerialBadges(
  serial: number | null,
  mint: number,
  existingLabels: Set<string>,
): string[] {
  const out: string[] = []
  if (serial == null) return out
  const hasPerfect = existingLabels.has("Perfect Serial")
  if (serial === 1 && !existingLabels.has("#1 Serial")) out.push("#1 Serial")
  if (mint > 0 && serial === mint && !hasPerfect) out.push("Perfect Serial")
  return out
}

// Whether to render the cleaned 30d price band beside the confidence badge. The
// RPC already gates the band to the high-volume LOW/MEDIUM cohort; we only show
// it when both ends resolved and the range is non-degenerate, so a bare "LOW"
// reads as "actively traded, wide range" rather than "no data".
export function showPriceBand(
  fmv: { confidence?: string | null; sales_count_30d?: number | null } | null | undefined,
  band: { low?: number | null; high?: number | null } | null | undefined,
): boolean {
  return (
    (fmv?.confidence === "LOW" || fmv?.confidence === "MEDIUM") &&
    (fmv?.sales_count_30d ?? 0) >= 10 &&
    band?.low != null &&
    band?.high != null &&
    band.high > band.low
  )
}

// Canonical edition URL a /moment/<id> page should point at, so the two URLs
// don't compete for the same query. The edition route slug is the edition's
// external_id for the standard collections (get_edition_detail resolves on
// external_id OR id), and the edition uuid for Pinnacle. Falls back to the
// self-canonical if we can't resolve a url slug (never emit a broken canonical).
export function momentCanonicalPath(input: {
  collectionSlug: string | null | undefined
  editionId: string
  externalId: string | null | undefined
  momentUrlId: string
}): string {
  const { collectionSlug, editionId, externalId, momentUrlId } = input
  const canonicalUrlSlug = collectionSlug ? fromDbSlug(collectionSlug) : null
  const isPinnacleColl = collectionSlug === "disney_pinnacle"
  const editionRouteSlug = isPinnacleColl ? editionId : (externalId ?? editionId)
  return canonicalUrlSlug && editionRouteSlug
    ? `/${canonicalUrlSlug}/edition/${encodeURIComponent(editionRouteSlug)}`
    : `/moment/${encodeURIComponent(momentUrlId)}`
}

// Ordered, de-nulled hero image candidate list. For Top Shot moments with a
// numeric on-chain id the per-moment media URL (which works on all legacy
// editions) is preferred over the stored edition thumbnail (which 404s on many
// Series 1-4 editions); other collections keep their stored thumbnail. Slow
// public ipfs.io gateway URLs are routed through the same-origin edge proxy.
export function buildHeroImageCandidates(input: {
  collectionSlug: string | null | undefined
  marketplaceNftId: string | null | undefined
  thumbnailUrl: string | null | undefined
}): string[] {
  const { collectionSlug, marketplaceNftId, thumbnailUrl } = input
  const isTopShotColl =
    collectionSlug === "nba_top_shot" || collectionSlug === "nba-top-shot"
  const tsHeroImg =
    isTopShotColl && marketplaceNftId && /^\d+$/.test(marketplaceNftId)
      ? `https://assets.nbatopshot.com/media/${marketplaceNftId}/image?width=1080`
      : null
  return [tsHeroImg, thumbnailUrl]
    .map(proxyIpfsUrl)
    .filter((u): u is string => !!u)
}

// Schema.org Product JSON-LD — a structured snapshot of the moment as a saleable
// item with current FMV as the price hint. A STALE FMV is an unreliable price
// hint, so the Offer is omitted entirely rather than let Google index a wrong
// price (a wrong indexed price is worse than none). Availability reflects real
// listing state: a live ask (serial is_listed=true with a list_price, or an
// edition-level top_shot_ask) is InStock; otherwise OutOfStock.
export function buildMomentProductLd(input: {
  subject: string
  serial: number | null
  mint: number
  setName: string | null | undefined
  collectionDisplay: string
  thumbnailUrl: string | null | undefined
  sku: string | null | undefined
  fmvConfidence: string | null | undefined
  fmvUsd: number | null | undefined
  floorPriceUsd: number | null | undefined
  topShotAsk: number | null | undefined
  isListed: boolean | null | undefined
  listPrice: number | null | undefined
}): Record<string, unknown> {
  const {
    subject, serial, mint, setName, collectionDisplay, thumbnailUrl, sku,
    fmvConfidence, fmvUsd, floorPriceUsd, topShotAsk, isListed, listPrice,
  } = input
  const priceForSchema =
    fmvConfidence === "STALE" ? null : (fmvUsd ?? floorPriceUsd ?? null)
  const hasLiveListing =
    (isListed === true && (listPrice ?? 0) > 0) ||
    (topShotAsk != null && topShotAsk > 0)
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    // Same trim/dedupe rule as generateMetadata — a null set_name must not leave
    // a trailing " · " on the product name.
    name: joinMetaParts([`${subject}${serial ? ` #${serial}/${mint}` : ""}`, metaField(setName)], " · "),
    description: `${joinMetaParts([subject, metaField(setName)], " ")} on ${collectionDisplay}`,
    image: thumbnailUrl ?? undefined,
    brand: { "@type": "Brand", name: collectionDisplay },
    sku,
    offers: priceForSchema != null
      ? {
          "@type": "Offer",
          priceCurrency: "USD",
          price: priceForSchema.toFixed(2),
          availability: hasLiveListing
            ? "https://schema.org/InStock"
            : "https://schema.org/OutOfStock",
        }
      : undefined,
  }
}
