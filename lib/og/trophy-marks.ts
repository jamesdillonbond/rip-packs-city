// lib/og/trophy-marks.ts
//
// What badges a Moment shows on a share card, derived once so the profile card,
// the trophy-case card and the moment card cannot disagree about the same
// Moment. Trevor, 2026-09-12: the Twitter/X image "needs to also include
// edition-wide badges (debut, rookie, championship, etc) along with special
// serial badges, for each moment displayed."
//
// ── THE TWO KINDS ARE SOURCED DIFFERENTLY, WHICH IS WHY THEY DEGRADE APART ──
//
// EDITION-WIDE badges arrive already resolved: `get_trophy_slab_data` builds its
// `badges` array from `get_edition_badges_unified(e.id)` — the canonical display
// source that applies the site's rollup rules — and only falls back to the
// pin-time snapshot when the edition cannot be resolved. ⚠ That is worth
// knowing before anyone adds a read for them: measured 2026-09-12 over the whole
// live pinned population (22 trophies, 21 resolvable), the RPC's array and a
// direct `get_edition_badges_unified` call agreed **21 of 21**, while the RAW
// `trophy_moments.badges` snapshot disagreed with it on **9 of 21**. The cards
// take the RPC's array and make no extra call. (The PDF route still makes one;
// it predates the RPC gaining the rollup and is now redundant.)
//
// SPECIAL SERIALS are computed, and only one of the three needs anything extra:
// `first` and `perfect` come off `serial_number` / `circulation_count`, which
// the RPC already returns. Only `jersey` needs `editions.jersey_number`, which
// the RPC reads but does not expose. So a failed jersey read costs exactly the
// jersey glyph and nothing else — the rest of the row is unaffected.
//
// ⚠ AND A MISSING GLYPH IS THE SAFE DIRECTION, BUT IT IS NOT FREE. Under-drawing
// a badge under-claims about a real Moment, which is the mirror of this repo's
// named defect (an `unknown` that is actually KNOWN, #80). It is accepted here
// because the alternative — drawing a jersey match we did not verify — is a
// FALSE claim about a named collector's Moment on a public timeline, and those
// are not the same size of wrong.

import { badgeColor } from "@/lib/trophy/slab-style"
import {
  badgeGlyphDataUri,
  glyphDataUri,
  GOLD_HEX,
  specialCats,
  specialGlyphDataUri,
  SPECIAL_CAT_LABEL,
  type SpecialCat,
} from "@/lib/badges/glyphs"
import { officialBadgeArtUrl, officialSpecialSerialArt } from "@/lib/badges/official-art"

/** The subset of a trophy row these marks are derived from. */
export interface TrophyMarkSource {
  badges?: unknown
  serial_number?: number | null
  circulation_count?: number | null
  edition_id?: string | null
  collection_id?: string | null
  /**
   * Either vocabulary — `badgePlatform` accepts a slug or a collection UUID.
   * ⚠ REQUIRED FOR CORRECT ART, not merely nice to have: All Day and Top Shot
   * share badge TITLES ("Rookie Year", "Championship Year") and have different
   * official art for them, so a title resolved without its collection draws
   * the wrong league's badge. Absent, every mark falls back to the RPC glyph,
   * which is wrong-looking but never wrong-claiming.
   */
  collection_slug?: string | null
}

export interface TrophyMark {
  /**
   * A `data:` URI that satori draws with NO network — the RPC glyph, or Top
   * Shot's official art, which is inline in the repo. Always present, so a
   * card can render a complete badge row having fetched nothing.
   */
  uri: string
  /**
   * A same-origin URL for this mark's OFFICIAL platform art, or null when the
   * platform publishes none. When present, `lib/og/official-mark-art.ts`
   * prefetches it and REPLACES `uri`; when the fetch fails, `uri` stands. That
   * is the whole degradation story: official art when we have it, RPC's mark
   * when we do not, and never an empty slot for a badge that was earned.
   */
  officialUrl: string | null
  /** Stable label; the React key, and what the tests assert on. */
  label: string
  special: boolean
}

/**
 * Key for an edition in a jersey-number lookup.
 *
 * ⚠ COLLECTION-QUALIFIED, because `editions.external_id` is unique per
 * COLLECTION, not globally — Top Shot's `165:6563` and another chain's `165:6563`
 * are different Moments, and an unqualified map would hand one player's jersey
 * number to the other. Same key the PDF route builds.
 */
export function editionKey(collectionId: string | null | undefined, externalId: string | null | undefined): string {
  return `${collectionId ?? ""}:${externalId ?? ""}`
}

/**
 * Marks for one Moment, gold special serials first then edition badges — the
 * order the Trophy Case PDF already draws them in.
 *
 * `max` bounds the row to what the tile can hold. Truncation is by the same
 * precedence: a jersey match survives a fourth "Rookie Year".
 */
export function trophyMarks(
  row: TrophyMarkSource,
  jersey: number | null,
  max = 4,
): TrophyMark[] {
  const out: TrophyMark[] = []

  // The collection drives the art tier for BOTH kinds of mark. Slug first (the
  // trophy RPC returns one), falling back to the collection UUID.
  const collection = row.collection_slug ?? row.collection_id ?? null

  for (const cat of specialCats(
    row.serial_number ?? null,
    row.circulation_count ?? null,
    jersey,
  )) {
    // ⭐ Top Shot resolves to OFFICIAL art with no fetch at all — the paths are
    // in the repo (lib/badges/official-art.ts). All Day gets a URL to prefetch.
    // Everything else keeps the RPC glyph, which on those platforms is the only
    // honest mark there is.
    const official = officialSpecialSerialArt(cat, collection, GOLD_HEX)
    out.push({
      uri: official?.kind === "inline" ? glyphDataUri(official.svg) : specialGlyphDataUri(cat),
      officialUrl: official?.kind === "url" ? official.url : null,
      label: SPECIAL_CAT_LABEL[cat as SpecialCat],
      special: true,
    })
  }

  // ⚠ The RPC types `badges` as jsonb, so it arrives as an array, `null`, or —
  // if a snapshot was ever written badly — something else entirely. Anything
  // that is not a non-empty string is dropped rather than drawn as a generic
  // glyph, because a glyph for a badge that does not exist is a fabricated one.
  const titles = Array.isArray(row.badges)
    ? row.badges.filter((b): b is string => typeof b === "string" && b.trim().length > 0)
    : []
  for (const title of titles) {
    out.push({
      uri: badgeGlyphDataUri(title, badgeColor(title)),
      // Null for 44 of the 53 taxonomy badges and for every Golazos / UFC /
      // Pinnacle badge — no art exists, so there is nothing to ask for.
      officialUrl: officialBadgeArtUrl(title, collection),
      label: title.trim(),
      special: false,
    })
  }

  return out.slice(0, Math.max(0, max))
}
