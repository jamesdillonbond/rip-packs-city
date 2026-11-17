// lib/badges/glyphs.ts
//
// THE ONE PLACE THE BADGE GLYPHS ARE DRAWN — shared by the Trophy Case PDF and
// by every OG share card.
//
// ── WHY A SHARED, DEPENDENCY-FREE MODULE ────────────────────────────────────
// These glyphs were born inside `app/api/profile/trophy-case/pdf/route.tsx`,
// where they had exactly one consumer. On 2026-09-12 Trevor asked for the same
// badges on the Twitter/X share images — "edition-wide badges (debut, rookie,
// championship, etc) along with special serial badges, for each moment
// displayed" — which gave them three more consumers across two runtimes.
//
// The obvious move, importing them from the PDF route, is impossible AND wrong:
//   * impossible, because their neighbour `lib/trophy-case/pdf-image.ts` pulls
//     in `pngjs` and `jpeg-js`, and `/api/og/profile/[username]` is `edge`;
//   * wrong, because a second copy is how a card and a PDF of the SAME six
//     Moments end up disagreeing about what a Moment is.
// So the geometry lives here, with NO imports at all, and the PDF re-exports
// what it used to own.
//
// ── ⚠ THIS MODULE IS THE FALLBACK TIER. IT WAS THE ONLY TIER FOR ONE DAY ────
// As first written (earlier on 2026-09-12) this file claimed the cards would
// use these glyphs "ALWAYS, with no network at all", on the reasoning that the
// PDF could afford Dapper's real art but a card could not: a card renders while
// a social crawler holds the connection open, and "six Moments × up to four
// badges is up to 24 image fetches".
//
// ⭐ THAT COUNTED MARKS, AND WHAT A RENDER PAYS FOR IS DISTINCT URLs. Measured
// the same day: only 9 of the 53 badges in `badge_taxonomy` have official art
// at all (plus 8 on All Day), they are same-origin 1.7–6.1 KB SVGs behind a
// proxy that caches them for a day, they repeat hard across a case, and Top
// Shot's special-serial art needs NO fetch because its paths are already in
// this repo. The real cost is a handful of deduped same-origin requests, not 24
// third-party ones.
//
// So the trade this header accepted — "a badge looks like RPC's mark on a card
// and like Dapper's on the PDF" — was paid for nothing, and it produced exactly
// the disagreement the section above was written to prevent, from the other
// direction: the PDF of a collector's trophy case showed Dapper's badges while
// the share card of the SAME six Moments showed RPC's drawings.
//
// `lib/badges/official-art.ts` now owns the tiering (official art where it
// exists, these glyphs where it does not) and `lib/og/official-mark-art.ts`
// does the deduped prefetch. THESE GLYPHS REMAIN LOAD-BEARING and are not
// deprecated — they are what 44 taxonomy badges, every Golazos / UFC / Pinnacle
// badge, and every failed official-art fetch draw. What changed is that they are
// no longer the FIRST answer, only the guaranteed one.
//
// ⚠ Which is why the "no network" promise stays true OF THIS MODULE and must:
// every card composes a complete, zero-network badge row out of these before
// any official art is fetched, so a Moment never loses a badge it earned to a
// failed request. A module that also deferred to remote art could not promise
// that, which is why the tiering sits ABOVE this file rather than inside it.
//
// ⚠ EVERY GLYPH IS PURE GEOMETRY IN A 24×24 BOX. No text, no `currentColor`, no
// CSS variable — satori resolves none of them, and the moment a glyph needs a
// character it is a font fetch again. Colour arrives as an argument.

/** Amber. The special-serial glyphs and the 1-of-1 slab accent both use it. */
export const GOLD_HEX = "#F59E0B"

/** Slugified badge title: "Rookie Of The Year" -> "rookie-of-the-year". */
export function normBadgeKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

// ── Special serials ─────────────────────────────────────────────────────────

/** Special-serial categories per the canonical definition (#1 / jersey / perfect). */
export type SpecialCat = "first" | "jersey" | "perfect"

/**
 * ⚠ THE CANONICAL DEFINITION, and the three guards in it are each load-bearing.
 *
 * `serial === 1` is "first" even on a 1-of-1; `circ > 1` is what stops a 1-of-1
 * ALSO counting as a perfect mint, which would draw two glyphs for one fact.
 * `jersey > 0` matters because `editions.jersey_number` is **0**, not null, for
 * a player with no number on file — Damian Lillard's row reads 0 today — and
 * without the guard every serial-1 Moment of his would claim a jersey match.
 */
export function specialCats(
  serial: number | null,
  circ: number | null,
  jersey: number | null,
): SpecialCat[] {
  if (!serial) return []
  const cats: SpecialCat[] = []
  if (serial === 1) cats.push("first")
  if (jersey != null && jersey > 0 && serial === jersey) cats.push("jersey")
  if (circ != null && circ > 1 && serial === circ) cats.push("perfect")
  return cats
}

/** Human label for a special serial — for alt text and tests, never for satori. */
export const SPECIAL_CAT_LABEL: Record<SpecialCat, string> = {
  first: "First Mint",
  jersey: "Jersey Match",
  perfect: "Perfect Mint",
}

// ── Geometry ────────────────────────────────────────────────────────────────

const STAR =
  "M12 3.2 L14.3 8.6 L20.2 9.1 L15.8 13 L17.1 18.8 L12 15.7 L6.9 18.8 L8.2 13 L3.8 9.1 L9.7 8.6 Z"

/**
 * Edition-wide badge glyphs, keyed by `normBadgeKey(title)`.
 * `generic` is the fallback, so an unrecognised badge still DRAWS rather than
 * silently vanishing — a Moment that carries a badge must never render as a
 * Moment that carries none.
 */
export const BADGE_GLYPH_BODY: Record<string, string> = {
  "rookie-year": `<path d="${STAR}"/>`,
  "rookie-mint": `<circle cx="12" cy="12" r="9.5"/><path d="M12 6.5 L13.5 10.2 L17.5 10.5 L14.5 13.1 L15.4 17 L12 14.9 L8.6 17 L9.5 13.1 L6.5 10.5 L10.5 10.2 Z"/>`,
  "championship-year": `<circle cx="12" cy="14.5" r="6.5"/><path d="M9.2 5 H14.8 L16.5 8.6 L12 10.5 L7.5 8.6 Z"/>`,
  "rookie-premiere": `<path d="M12 2.8 L13.9 7.2 L18.7 7.6 L15.1 10.8 L16.2 15.5 L12 13 L7.8 15.5 L8.9 10.8 L5.3 7.6 L10.1 7.2 Z"/><path d="M8 16.5 L7 21.5 L12 19 L17 21.5 L16 16.5"/>`,
  "rookie-of-the-year": `<path d="M7 4 H17 V9 A5 5 0 0 1 7 9 Z"/><path d="M7 5.5 H4.5 A0.2 0.2 0 0 0 4.5 9.5 A3.5 3.5 0 0 0 7.4 11"/><path d="M17 5.5 H19.5 A0.2 0.2 0 0 1 19.5 9.5 A3.5 3.5 0 0 1 16.6 11"/><path d="M12 14 V17 M9 20 H15 M10 17 H14 L15 20 H9 Z"/>`,
  "top-shot-debut": `<circle cx="12" cy="14" r="4.5"/><path d="M12 2.5 V6.5 M5.3 5.3 L8 8 M18.7 5.3 L16 8"/>`,
  "three-stars": `<path d="M6 10.5 L6.9 12.6 L9.2 12.8 L7.5 14.3 L8 16.6 L6 15.4 L4 16.6 L4.5 14.3 L2.8 12.8 L5.1 12.6 Z"/><path d="M12 5.5 L12.9 7.6 L15.2 7.8 L13.5 9.3 L14 11.6 L12 10.4 L10 11.6 L10.5 9.3 L8.8 7.8 L11.1 7.6 Z"/><path d="M18 10.5 L18.9 12.6 L21.2 12.8 L19.5 14.3 L20 16.6 L18 15.4 L16 16.6 L16.5 14.3 L14.8 12.8 L17.1 12.6 Z"/>`,
  generic: `<circle cx="12" cy="10" r="5.5"/><path d="M9.5 14.5 L8.5 21 L12 18.7 L15.5 21 L14.5 14.5"/>`,
}
BADGE_GLYPH_BODY["three-star-rookie"] = BADGE_GLYPH_BODY["three-stars"]

/** Special-serial glyphs — medal (#1 / 1-of-1), jersey, target (perfect). */
export const SPECIAL_GLYPH_BODY: Record<SpecialCat, string> = {
  first: `<circle cx="12" cy="9" r="6"/><path d="M9 14 L8 22 L12 19 L16 22 L15 14"/><circle cx="12" cy="9" r="2.1" fill="${GOLD_HEX}" stroke="none"/>`,
  jersey: `<path d="M8 3.5 L4 6.5 L6 10 L8 8.8 V20.5 H16 V8.8 L18 10 L20 6.5 L16 3.5 A4 4 0 0 1 8 3.5 Z"/>`,
  perfect: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="1.4" fill="${GOLD_HEX}" stroke="none"/>`,
}

/** Wrap a glyph body in a 24×24 monoline SVG. */
export function glyphSvg(body: string, color: string, strokeWidth = 1.7): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" ` +
    `stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`
  )
}

/** The glyph body for a badge TITLE, falling back to `generic`. */
export function badgeGlyphBody(title: string): string {
  return BADGE_GLYPH_BODY[normBadgeKey(title)] ?? BADGE_GLYPH_BODY.generic
}

/**
 * A `data:` URI satori can draw with ZERO network I/O.
 *
 * ⚠ PERCENT-ENCODED, NOT BASE64, deliberately. `Buffer` is a Node global that
 * the `edge` runtime only polyfills by grace, and `/api/og/profile/[username]`
 * is edge — an encoder that works in the test env and throws in production is
 * the worst of the available failure modes. `encodeURIComponent` is on every
 * runtime these routes deploy to.
 */
export function glyphDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Ready-to-draw data URI for an edition badge title. */
export function badgeGlyphDataUri(title: string, color: string): string {
  return glyphDataUri(glyphSvg(badgeGlyphBody(title), color))
}

/** Ready-to-draw data URI for a special serial. Always gold. */
export function specialGlyphDataUri(cat: SpecialCat): string {
  return glyphDataUri(glyphSvg(SPECIAL_GLYPH_BODY[cat], GOLD_HEX))
}
