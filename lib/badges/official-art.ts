// lib/badges/official-art.ts
//
// THE ONE PLACE THAT ANSWERS "does official platform art exist for this badge,
// and where is it?" — for edition-wide badges AND for special serials.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// On 2026-09-12 four parallel badge implementations were live and the share
// cards had picked the only INVENTED one, so the PDF of a collector's trophy
// case drew Dapper's badges while the share card of the SAME six Moments drew
// RPC's. `lib/badges/glyphs.ts`'s own header was written to stop "a card and a
// PDF of the SAME six Moments disagreeing about what a Moment is" and produced
// exactly that from the other direction. The four were:
//
//   1. components/SpecialSerialGlyph.tsx  — official, tiered by platform, used
//      site-wide (moment pages, sniper, edition pages, special-serial-owners).
//      Trevor-directed, 2026-07-11, verified against the live platforms.
//   2. lib/badges/server-art.ts           — the server-side resolver for
//      non-React renderers (reads get_badge_display_metadata).
//   3. app/api/profile/trophy-case/pdf/   — fetches official art, RPC fallback.
//   4. lib/badges/glyphs.ts               — invented geometry, cards only.
//
// This module is the TIERING, lifted from (1) rather than re-derived, so the
// cards can reach the same answer without importing React. `glyphs.ts` keeps
// its job — it is now the FALLBACK TIER, which is what its "ALWAYS, with no
// network" contract can honestly promise. A module that defers to official art
// cannot also promise to always draw without a network, so the tiering had to
// sit ABOVE it rather than inside it.
//
// ── ⚠ WHY THIS IS A FIFTH FILE AND NOT A CALL INTO (2) ──────────────────────
// The correction that ordered this work said, correctly, to check
// `lib/badges/server-art.ts` before writing another resolver. It was checked,
// and it is NOT duplicated here — it keeps every caller it has. It answers the
// same question this file answers, from the database:
// `fetchBadgeArt(titles, collectionId)` calls `get_badge_display_metadata`,
// which resolves `COALESCE(badge_art_overrides.icon_url, badge_taxonomy.
// icon_url)`. That is the RIGHT shape for its callers — `/moment/[id]` and
// `/[collection]/edition/[slug]`, server PAGES that are already making DB reads
// and whose badge set is not known ahead of time.
//
// It is the wrong shape for an OG card, for three reasons, and the third is
// decisive:
//   * it costs a DB round trip on the path a social crawler is holding open,
//     for a set of 17 rows that changes a few times a year;
//   * its budget is a PAGE budget (BADGE_ART_TIMEOUT_MS = 4s, sized to block a
//     loading skeleton), not a card's decoration budget;
//   * it imports `supabaseAdmin`, and `/api/og/profile/[username]` is `edge`.
//     Reaching for it there would drag a service-role Node client onto an edge
//     route — the same reason `glyphs.ts` could not simply import from the PDF.
//
// So the SPLIT IS BY RUNTIME AND BUDGET, not by vocabulary: both resolve the
// same (title, collection) -> icon_url mapping, and `scripts/check-badge-art-
// registry-drift.mjs` is what keeps this file's static copy honest against the
// tables (2) reads live. If that guard ever has to be deleted, collapse this
// into (2) instead — a static mirror with no drift check is strictly worse than
// a DB read.
//
// (3), the PDF route, is left ALONE deliberately: it already fetches official
// art with an RPC fallback, which is the behaviour this change gives the cards.
// It and the cards now AGREE about the same six Moments, which was the point.
//
// ── WHAT IS AND IS NOT AVAILABLE ────────────────────────────────────────────
// ⚠ THE SPEC THAT ORDERED THIS WORK SAID "53 BADGES, PREFETCH ALL 53". That is
// not what the database holds. Measured live 2026-09-12:
//
//   badge_taxonomy                     53 rows, of which  9 carry an icon_url
//   badge_art_overrides (nba_top_shot)  7 rows  (the same 9 minus 2)
//   badge_art_overrides (nfl_all_day)   8 rows
//
// So official EDITION-badge art exists for 9 Top Shot titles and 8 All Day
// titles — NOT 53. The other 44 taxonomy rows have no art anywhere, and for
// them the RPC glyph is not a stopgap, it is the only honest mark available.
// That is why `officialBadgeArtUrl` returns null rather than guessing a slug:
// a 404 from a guessed slug would degrade to the same fallback, but it would
// spend a crawler's connection to get there.
//
// ⚠ AND THE ART IS COLLECTION-AWARE, via a table the ordering spec did not
// mention. `get_badge_display_metadata` resolves
// `COALESCE(badge_art_overrides.icon_url, badge_taxonomy.icon_url)` keyed on
// (collection_id, normalized_key) — All Day's "Rookie Year" and Top Shot's
// share a title and have DIFFERENT art. Resolving a title without its
// collection draws the wrong league's badge on a named collector's Moment,
// which is the same class of wrong as the caption bug this card was just
// fixed for. Hence every entry point here takes a collection.
//
// ⚠ THIS REGISTRY IS A STATIC MIRROR OF DB STATE AND CAN GO STALE. It is
// static on purpose — an OG card renders while a social crawler holds the
// connection, and a per-card taxonomy read buys nothing for a set that changes
// a few times a year. The drift is not left to trust:
// `scripts/check-badge-art-registry-drift.mjs` (npm run badges:art:check)
// diffs it against the LIVE badge_taxonomy + badge_art_overrides, in BOTH
// directions, so an added row and a removed one both red.

import { normalizeBadgeKey } from "./normalize"
import type { SpecialCat } from "./glyphs"

/** The two platforms that publish their own badge art. */
export type BadgePlatform = "topshot" | "allday"

/**
 * Collection UUIDs, needed because the two trophy cards carry `collection_id`
 * and only sometimes `collection_slug`. Hardcoded ids are an established
 * pattern here (`lib/fmv-display-guard.ts`, `lib/sitemap-data.ts`); the
 * canonical table is docs/reference/schema-truth.md.
 */
const COLLECTION_ID_TOPSHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const COLLECTION_ID_ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"

/**
 * Resolve a platform from EITHER vocabulary — a slug in any of its spellings,
 * or a collection UUID.
 *
 * ⚠ Accepts both because the three callers differ: the moment card has
 * `collection_slug`, the profile card's typed row carries `collection_id`, and
 * the trophy RPC returns both. Returning null (Golazos / UFC / Pinnacle /
 * anything unrecognised) is a real answer, not a failure: those platforms
 * publish no badge art, so the fallback tier is correct for them.
 */
export function badgePlatform(
  collection: string | null | undefined,
): BadgePlatform | null {
  const c = (collection ?? "").toLowerCase().trim()
  if (!c) return null
  if (c === COLLECTION_ID_TOPSHOT) return "topshot"
  if (c === COLLECTION_ID_ALLDAY) return "allday"
  if (c === "nba-top-shot" || c === "nba_top_shot" || c === "topshot") return "topshot"
  if (c === "nfl-all-day" || c === "nfl_all_day" || c === "allday") return "allday"
  return null
}

// ── Edition-wide badges ─────────────────────────────────────────────────────

/**
 * normalized_key -> the `name=` slug the /api/badge-image proxy accepts.
 *
 * ⚠ EVERY SLUG HERE MUST BE IN THAT ROUTE'S ALLOWLIST (`TOPSHOT_SLUGS` /
 * `ALLDAY_SLUGS` in app/api/badge-image/route.ts), because the allowlist is
 * that route's injection guard — a slug it does not know is a 400, which is a
 * spent connection for a badge we could have drawn locally. The drift check
 * asserts both directions of that too.
 *
 * Mirrors live DB state as of 2026-09-12 (a DATED SAMPLE — re-run the drift
 * check rather than quoting it).
 */
const TOPSHOT_BADGE_SLUGS: Record<string, string> = {
  challengereward: "challengeReward",
  championshipyear: "championshipYear",
  leaderboardreward: "codenameMercury",
  rookiemint: "rookieMint",
  rookieoftheyear: "rookieOfTheYear",
  rookiepremiere: "rookiePremiere",
  rookieyear: "rookieYear",
  threestarrookie: "threeStars",
  topshotdebut: "topShotDebut",
}

const ALLDAY_BADGE_SLUGS: Record<string, string> = {
  alldaydebut: "all-day-debut",
  challengereward: "challenge-reward",
  championshipyear: "championship-year",
  craftedreward: "crafted-reward",
  dynamicmoment: "dynamic-moment",
  halloffame: "hall-of-fame",
  rookiemint: "rookie-mint",
  rookieyear: "rookie-year",
}

/** Exported for the drift check, which diffs these against the live tables. */
export const BADGE_ART_SLUGS: Record<BadgePlatform, Record<string, string>> = {
  topshot: TOPSHOT_BADGE_SLUGS,
  allday: ALLDAY_BADGE_SLUGS,
}

/**
 * Own-property lookup. `Object.create(null)` would do as well, but a badge
 * title normalizing to "constructor" resolving to a function is exactly the
 * kind of thing that renders as a broken image months later.
 */
function ownGet(map: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

/**
 * The same-origin URL for a badge title's OFFICIAL art, or null when the
 * platform publishes none for it (44 of the 53 taxonomy rows, and every badge
 * on Golazos / UFC / Pinnacle).
 *
 * Relative on purpose — `lib/og/img-data.ts` resolves a site-relative path
 * against NEXT_PUBLIC_SITE_URL, and hardcoding the apex here would break every
 * preview deployment's cards.
 */
export function officialBadgeArtUrl(
  title: string,
  collection: string | null | undefined,
): string | null {
  const platform = badgePlatform(collection)
  if (!platform) return null
  const slug = ownGet(BADGE_ART_SLUGS[platform], normalizeBadgeKey(title))
  if (!slug) return null
  return `/api/badge-image?src=${platform}&name=${encodeURIComponent(slug)}`
}

// ── Special serials ─────────────────────────────────────────────────────────

/**
 * ⭐ TOP SHOT'S SPECIAL-SERIAL ART COSTS NO NETWORK AT ALL — the exact paths
 * are in the repo. Lifted verbatim from components/SpecialSerialGlyph.tsx,
 * which took them from nbatopshot.com v2 and verified them against
 * dapper.market moment 2149353 on 2026-07-11 (Trevor-directed). This is the
 * single best trade in the whole badge-art change: the most-shared platform
 * gets its REAL badges for the same zero fetches the invented glyphs cost.
 *
 * ⚠ TWO DELIBERATE EDITS FROM THE COMPONENT, both forced by satori:
 *
 *  1. `currentColor` IS GONE. In the component these inherit the pill's colour
 *     from CSS. A data: URI has no CSS context, so `currentColor` resolves to
 *     black — an invisible badge on a black card, which is the failure mode
 *     that looks like "no badge" rather than like an error. The colour is
 *     substituted in by `topShotSpecialSvg` instead, the same way
 *     `glyphs.ts#glyphSvg` takes it as an argument.
 *
 *  2. THE `clipPath` WRAPPERS ARE GONE. Both were `rect(1.5,1.5,9,9)`, and
 *     every path in both glyphs lies inside that rect — the clips were no-ops
 *     in the component and dropping them removes a satori feature dependency
 *     without changing a pixel. Checked coordinate by coordinate, not assumed:
 *     both glyphs' extrema are 1.5 and 10.5 on each axis.
 */
const TOPSHOT_SPECIAL_PATHS: Record<SpecialCat, string> = {
  first:
    `<path d="M5.99156 9.59775L4.63256 8.2365L4.18875 8.68087L6.0045 10.5L7.81519 8.68538L7.35844 8.22806L5.99156 9.59775ZM8.68481 4.18538L8.2365 4.63481L9.59044 5.99156L8.21906 7.36631L8.68031 7.82756L10.5 6.00506L8.68481 4.18538ZM3.75112 4.63144L3.31069 4.18988L1.5 6.0045L3.31519 7.82362L3.768 7.36969L2.39269 5.99156L3.75112 4.63144ZM4.18425 3.32363L4.62019 3.76013L5.99156 2.38594L7.37138 3.768L7.81969 3.31912L6.0045 1.5L4.18425 3.32363Z" fill="__C__"/>` +
    `<path d="M5.92524 8.35632L7.08286 7.19588V4.78782L5.92524 3.62738L3.56555 5.99213H4.92849L5.93255 4.95657L5.92524 5.99157V8.35632Z" fill="__C__"/>`,
  jersey:
    `<path d="M10 11H2V10H10V11ZM4.5 1C4.5 1.82843 5.17157 2.5 6 2.5C6.82843 2.5 7.5 1.82843 7.5 1H8.5V3.5C8.5 4.32843 9.17157 5 10 5V9H2V5C2.82843 5 3.5 4.32843 3.5 3.5V1H4.5Z" fill="__C__"/>`,
  perfect:
    `<path d="M5.96734 4.35638C5.75125 4.35999 5.53804 4.4065 5.34009 4.49322C5.14213 4.57993 4.96338 4.70512 4.81421 4.8615C4.66424 5.01682 4.54659 5.20037 4.46809 5.4015C4.38959 5.60263 4.35179 5.81734 4.3569 6.03319C4.36621 6.46879 4.54791 6.88292 4.86216 7.18472C5.17641 7.48652 5.59753 7.65136 6.03315 7.64306C6.2491 7.63945 6.46218 7.59299 6.66004 7.50637C6.85789 7.41976 7.03657 7.29472 7.18571 7.1385C7.48946 6.82182 7.65259 6.40613 7.64359 5.96681C7.63443 5.53111 7.45279 5.11685 7.13853 4.81492C6.82427 4.513 6.40306 4.34809 5.96734 4.35638Z" fill="__C__"/>` +
    `<path d="M8.16114 3.81751C7.87481 3.53315 7.53507 3.30823 7.16147 3.1557C6.78787 3.00317 6.38779 2.92605 5.98426 2.92876C5.58093 2.9298 5.1818 3.01072 4.80991 3.16683C4.43802 3.32294 4.10073 3.55116 3.81751 3.83832C3.53315 4.12465 3.30823 4.46439 3.1557 4.83799C3.00317 5.21159 2.92605 5.61167 2.92876 6.0152C2.92988 6.4187 3.01093 6.81798 3.16724 7.18998C3.32355 7.56198 3.55202 7.89932 3.83945 8.18251C4.41375 8.75284 5.19063 9.07241 6.00001 9.07126H6.01576C6.41936 9.07022 6.81875 8.9892 7.19085 8.83289C7.56295 8.67658 7.90038 8.44807 8.18364 8.16057C8.468 7.87425 8.69291 7.53451 8.84544 7.16091C8.99797 6.78731 9.0751 6.38723 9.07239 5.9837C9.07087 5.58026 8.98963 5.1811 8.83335 4.80915C8.67706 4.43721 8.4488 4.09982 8.1617 3.81639M7.87764 7.85739C7.63404 8.10456 7.34388 8.30103 7.02393 8.43542C6.70397 8.56981 6.36055 8.63948 6.01351 8.64039H6.00001C5.30387 8.64182 4.63563 8.36688 4.14207 7.87595C3.89496 7.63242 3.69854 7.34235 3.56415 7.0225C3.42976 6.70264 3.36006 6.35933 3.35907 6.01239C3.35651 5.66533 3.42274 5.3212 3.55395 4.99989C3.68516 4.67857 3.87874 4.38645 4.12351 4.14039C4.36704 3.89327 4.65711 3.69685 4.97696 3.56246C5.29682 3.42807 5.64013 3.35837 5.98707 3.35739H6.00114C6.70145 3.35739 7.3607 3.62851 7.85907 4.12182C8.10619 4.36535 8.30261 4.65542 8.437 4.97528C8.57139 5.29513 8.64109 5.63844 8.64207 5.98539C8.64464 6.33245 8.5784 6.67657 8.4472 6.99789C8.31599 7.3192 8.1224 7.61133 7.87764 7.85739ZM10.1462 4.24839C10.0325 3.97954 9.8929 3.72239 9.72939 3.48057L9.41889 3.79107C9.7794 4.34828 9.99807 4.98524 10.0558 5.64638C10.1136 6.30752 10.0086 6.97274 9.7502 7.58401C9.65927 7.8006 9.54914 8.00862 9.42114 8.20557L9.73164 8.51607C10.2327 7.77265 10.5002 6.89651 10.5 6.00001C10.5011 5.39828 10.3808 4.80251 10.1462 4.24839ZM4.41601 2.24982C4.91719 2.038 5.45591 1.92934 6.00001 1.93032C6.78335 1.929 7.55026 2.15487 8.20782 2.58057L8.51832 2.27007C7.7749 1.76707 6.89761 1.49881 6.00001 1.50001C5.10168 1.49794 4.22354 1.76648 3.48001 2.27064L3.79051 2.58114C3.98864 2.45214 4.19799 2.34126 4.41601 2.24982ZM7.58457 9.7502C7.08322 9.96209 6.5443 10.0708 6.00001 10.0697C5.2178 10.071 4.45196 9.84572 3.79501 9.42114L3.48395 9.73164C4.22692 10.2336 5.10336 10.5013 6.00001 10.5C6.89929 10.502 7.77829 10.2329 8.52226 9.7277L8.21176 9.4172C8.01298 9.54689 7.80287 9.65835 7.58401 9.7502M1.93032 6.00001C1.92883 5.21673 2.15451 4.44983 2.58001 3.7922L2.26951 3.48114C1.7666 4.22478 1.49853 5.10228 1.50001 6.00001C1.49798 6.89929 1.76713 7.77829 2.27232 8.52226L2.58282 8.21176C2.1556 7.55332 1.92891 6.78491 1.93032 6.00001Z" fill="__C__"/>`,
}

/** The All Day slugs for the three special serials — official badgesV3 art. */
const ALLDAY_SPECIAL_SLUGS: Record<SpecialCat, string> = {
  first: "first-serial",
  jersey: "player-number",
  perfect: "perfect-serial",
}

/** Exported so the drift check can assert the badge-image allowlist covers them. */
export const SPECIAL_SERIAL_SLUGS = {
  allday: ALLDAY_SPECIAL_SLUGS,
} as const

/**
 * Top Shot's official special-serial art as a self-contained SVG string, with
 * the colour baked in. Zero network, by construction.
 */
export function topShotSpecialSvg(cat: SpecialCat, color: string): string {
  const body = TOPSHOT_SPECIAL_PATHS[cat].split("__C__").join(color)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" fill="none">${body}</svg>`
  )
}

/**
 * What art to use for one special serial, tiered exactly as
 * SpecialSerialGlyph tiers it site-wide.
 *
 *   topshot -> { kind: "inline" }  official paths, no fetch
 *   allday  -> { kind: "url" }     official badgesV3 art, one same-origin fetch
 *   else    -> null                no official art exists; caller keeps its
 *                                  RPC-brand mark
 *
 * ⚠ THE null BRANCH IS AN HONESTY BOUNDARY, NOT A GAP. On Golazos, UFC and
 * Pinnacle no platform badge exists, so an RPC mark there is RPC's own
 * notation — it must not be dressed up as a platform credential, which is
 * precisely the line SpecialSerialGlyph already draws. Flattening all three
 * tiers into one row of identical marks would erase that distinction, so the
 * tiering is preserved rather than simplified away.
 */
export function officialSpecialSerialArt(
  cat: SpecialCat,
  collection: string | null | undefined,
  color: string,
): { kind: "inline"; svg: string } | { kind: "url"; url: string } | null {
  const platform = badgePlatform(collection)
  if (platform === "topshot") return { kind: "inline", svg: topShotSpecialSvg(cat, color) }
  if (platform === "allday") {
    return {
      kind: "url",
      url: `/api/badge-image?src=allday&name=${encodeURIComponent(ALLDAY_SPECIAL_SLUGS[cat])}`,
    }
  }
  return null
}
