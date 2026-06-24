// lib/media/momentVideoUrl.ts
//
// Derives a per-collection video URL for a single moment so the Trophy
// modal (and any future moment-detail surface) can autoplay the on-chain
// animation instead of just showing the thumbnail.
//
// Per-collection patterns (verified against the live CDNs as of 2026-05):
//   nba_top_shot     https://assets.nbatopshot.com/media/{moment_id}/video
//   nfl_all_day      https://media.nflallday.com/editions/{edition_id}/media/video
//   laliga_golazos   https://assets.laligagolazos.com/editions/{edition_key}/play_{edition_key}__capture_Animated_Video_Popout_Black_1080_1080_default.mp4
//   ufc_strike       NOT derivable — per-edition video IPFS CID lives in editions.video_url
//   disney_pinnacle  no public video CDN — fall back to the still thumbnail
//
// Returns null when the necessary input field is missing — callers should
// render the thumbnail as a poster + skip the video element entirely.

import { getCollectionByUuid } from "@/lib/collections"

export interface MomentMediaInputs {
  /** Supabase collections.id UUID. Preferred. */
  collectionUuid?: string | null
  /** Hyphen slug ("nba-top-shot"). Used as a fallback when collectionUuid isn't available. */
  collectionSlug?: string | null
  momentId?: string | null
  editionId?: string | null
  /** Optional — only Golazos uses it. Format: "{royalty}:{variant}:{printing}" or similar. */
  editionKey?: string | null
  thumbnailUrl?: string | null
}

function resolveSlug(inputs: MomentMediaInputs): string | null {
  if (inputs.collectionSlug) return inputs.collectionSlug
  if (inputs.collectionUuid) {
    const c = getCollectionByUuid(inputs.collectionUuid)
    return c?.id ?? null
  }
  return null
}

export function deriveMomentVideoUrl(inputs: MomentMediaInputs): string | null {
  const slug = resolveSlug(inputs)
  if (!slug) return null

  switch (slug) {
    case "nba-top-shot": {
      if (!inputs.momentId) return null
      return `https://assets.nbatopshot.com/media/${encodeURIComponent(inputs.momentId)}/video`
    }
    case "nfl-all-day": {
      if (!inputs.editionId) return null
      // Bare path only — the ?width=&format=mp4 endpoint is an image resizer and
      // returns "ERROR 9401: 'mp4' is not a supported output format" for video.
      // Live <video> src on app.nflallday.com uses the unparameterized path.
      return `https://media.nflallday.com/editions/${encodeURIComponent(inputs.editionId)}/media/video`
    }
    case "laliga-golazos": {
      if (!inputs.editionKey) return null
      const ek = encodeURIComponent(inputs.editionKey)
      return `https://assets.laligagolazos.com/editions/${ek}/play_${ek}__capture_Animated_Video_Popout_Black_1080_1080_default.mp4`
    }
    case "ufc":
      // UFC video is a per-edition IPFS CID, distinct from the (single-file IPFS
      // image) thumbnail — there is nothing here to derive it from. The real URL
      // lives in editions.video_url (backfilled 2026-06-24 from on-chain
      // MetadataViews.Medias) and reaches consumers directly: the grids/edition
      // pages read editions.video_url, and the Trophy modal prefers
      // trophy.video_url before falling back to this helper. So return null.
      return null
    case "disney-pinnacle":
      // Pinnacle has no public video CDN today. Fall back to thumbnail.
      return null
    default:
      return null
  }
}

// Per-collection on-chain contract addresses for Flowty asset deeplinks.
// Hardcoded here (rather than reading lib/collections.ts) because this map is
// the canonical source for the trophy modal's "View on Flowty" link.
const FLOWTY_CONTRACT_BY_SLUG: Record<string, string> = {
  "nba-top-shot": "0x0b2a3299cc857e29",
  "nfl-all-day": "0xe4cf4bdc1751c65d",
  "laliga-golazos": "0x87ca73a41bb50ad5",
  "disney-pinnacle": "0xedf9df96c92f4595",
  "ufc": "0x329feb3ab062d289",
}

export function flowtyAssetUrl(inputs: MomentMediaInputs): string | null {
  const slug = resolveSlug(inputs)
  if (!slug || !inputs.momentId) return null
  const contract = FLOWTY_CONTRACT_BY_SLUG[slug]
  if (!contract) return null
  return `https://www.flowty.io/asset/${contract}/${encodeURIComponent(inputs.momentId)}`
}

export function rpcMomentUrl(inputs: MomentMediaInputs): string | null {
  const slug = resolveSlug(inputs)
  if (!slug || !inputs.momentId) return null
  return `/${slug}/moment/${encodeURIComponent(inputs.momentId)}`
}

export function topShotMomentUrl(inputs: MomentMediaInputs): string | null {
  const slug = resolveSlug(inputs)
  if (slug !== "nba-top-shot" || !inputs.momentId) return null
  return `https://nbatopshot.com/moment/${encodeURIComponent(inputs.momentId)}`
}
