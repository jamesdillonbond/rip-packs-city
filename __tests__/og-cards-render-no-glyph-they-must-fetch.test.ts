import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

/**
 * AN OG CARD MAY NOT RENDER A GLYPH IT HAS TO GO TO THE INTERNET FOR.
 *
 * Replaces `og-cards-do-not-silently-acquire-a-cdn-dependency`, which recorded
 * six routes as allowed to reach cdn.jsdelivr.net and asked only that a SEVENTH
 * be a deliberate decision. All six are fixed (lib/og/marks.tsx), so this is now
 * a BAN AT ZERO instead of a curated list of the past.
 *
 * ── WHAT next/og ACTUALLY DOES ───────────────────────────────────────────────
 * It resolves glyphs at RENDER time — on the one path a social crawler waits on
 * — and it has TWO remote fallbacks, both unbounded:
 *
 *   1. an EMOJI            -> cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/...
 *   2. ANY glyph the supplied fonts miss
 *                          -> fonts.googleapis.com/css2?family=Noto+Sans+Symbols
 *
 * Only the first was ever recorded. Measured 2026-08-29, one character per
 * `ImageResponse`, network closed, escapes recorded:
 *
 *   jsdelivr   1f3af 2b50 1f4e6 1f389 1f3b4 1f48e 1f3c6 26a1 1f4da 1f4b0 1f392 26a0
 *   googlefont 2605 25c8 25a3 25a6 2192 2191 2193 2190 25b2 25bc 2713 2715 2153 2116 203e
 *   local      every accented Latin name that matters here (Jokic, Doncic,
 *              Porzingis, Sengun, Bogdanovic, with their real diacritics) and
 *              the punctuation in COVERED below, U+2212 MINUS SIGN included
 *
 * ⚠ THE SECOND FALLBACK IS INVISIBLE TO A PROBE THAT DOES NOT SUPPLY THE BRAND
 * FONTS. Satori's bundled default covers arrows; production never uses it,
 * because every card passes `brandFonts()`. A first pass here measured with no
 * `fonts` option, saw U+2192 fetch nothing, and concluded the register had
 * wrongly flagged `insights/serial-premiums`. It had not.
 *
 * ── WHY THIS IS A SUPPRESSION LIST AND NOT A DETECTION LIST ──────────────────
 * The obvious guard enumerates the bad characters. That list is a description of
 * the past: the next emoji someone pastes is not on it, and the guard passes.
 * So COVERED enumerates what is PROVEN LOCAL and everything else fails. A new
 * character is flagged by default, and clearing it costs one measurement.
 *
 * ── WHAT THIS GUARD IS STRUCTURALLY BLIND TO, AND WHAT COVERS THAT ───────────
 * Source. It cannot see a glyph that arrives through DATA — `og/collection`
 * rendered `collection.icon` at 140px and every icon in lib/collections.ts is an
 * emoji, so the card's largest element was a CDN fetch that no scan of this
 * directory could ever have found.
 *
 * `api-og-cards-render-sweep` covers exactly that: it renders every card with
 * the network closed and FAILS on any escape, data-driven glyphs included. Its
 * own blind spot is the mirror image — it only sees the branches its fixtures
 * take, which is why removing the arrow from `insights/serial-premiums` reds
 * THIS file and leaves the sweep green (that card renders its empty-state
 * fallback under the sweep's stub envelope, measured 2026-08-29).
 *
 * Neither is a census. Together they have no gap that is not a branch reachable
 * only in production with a glyph only in data.
 */

const ROOTS = [path.join(process.cwd(), "app/api/og"), path.join(process.cwd(), "lib/og")]

/**
 * Characters MEASURED to render from the vendored brand fonts with no network
 * call. Anything outside this set is presumed remote.
 *
 * ⚠ To add one: render it through `ImageResponse` with `brandFonts()` supplied
 * and a fetch that records http(s) calls. If it fetches nothing, add it here
 * with that measurement. Do not add a character because it "looks like text" —
 * U+2192 and U+2212 look equally like text and only one of them is local.
 *
 *   U+0000-U+007F   ASCII
 *   U+00A0-U+024F   Latin-1 Supplement + Latin Extended-A/B (accented names,
 *                  and the punctuation these cards use: · « »
 *                  ° © ® § ± ½)
 *   the rest       individually measured
 */
const COVERED =
  /[\u0000-\u007F\u00A0-\u024F\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u2030\u2032\u2033\u2039\u203A\u2044\u20AC\u2122\u2212]/u

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(p, out)
    else if (/\.(tsx?|jsx?)$/.test(entry.name) && statSync(p).isFile()) out.push(p)
  }
  return out
}

/**
 * Comments stripped: a character in prose is documentation, not a render — this
 * file's own header names half the emoji in the repo.
 *
 * ⚠ The SHARED stripper, never a local copy (`guards-use-the-shared-comment-
 * stripper` is a ratchet). And because calling it is not proof that it stripped
 * — it has been blind three times — the "prose does not count" case below is a
 * control on the stripping, not a formality.
 */
function rendered(file: string): string {
  return stripComments(readFileSync(file, "utf8"))
}

function uncovered(file: string): string[] {
  const found = new Set<string>()
  for (const ch of rendered(file)) if (!COVERED.test(ch)) found.add(ch)
  return [...found].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
}

function rel(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join("/")
}

describe("OG cards render no glyph they must fetch", () => {
  const files = ROOTS.flatMap((r) => sourceFiles(r))

  it("inspected a non-empty set of files (the guard cannot pass vacuously)", () => {
    // 44 route.tsx + the lib/og helpers as of 2026-08-29. Asserting the COUNT
    // INSPECTED, not just that the walk ran: a walk that silently returned []
    // would pass every case below while measuring nothing.
    expect(files.length).toBeGreaterThan(40)
  })

  it("no OG source renders a character outside the measured-local set", () => {
    const offenders = files
      .map((f) => ({ file: rel(f), codepoints: uncovered(f) }))
      .filter((o) => o.codepoints.length > 0)
    expect(
      offenders,
      "next/og resolves these at RENDER time by fetching cdn.jsdelivr.net (emoji) or " +
        "fonts.googleapis.com (any glyph the brand fonts miss), on the path a social " +
        "crawler is waiting on, with no local fallback available through ImageResponse's " +
        "public API. Draw it instead: lib/og/marks.tsx. If you have MEASURED that it " +
        "renders locally with brandFonts() supplied, add it to COVERED with that " +
        "measurement.",
    ).toEqual([])
  })

  it("prose does not count as a render (control on the comment stripper)", () => {
    // This file's own header is full of characters the guard bans. If the
    // stripper were blind, the guard above would be firing on documentation and
    // every one of its passes would mean nothing.
    const raw = readFileSync(__filename, "utf8")
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(raw)).toBe(false)
    const marks = path.join(process.cwd(), "lib/og/marks.tsx")
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(readFileSync(marks, "utf8"))).toBe(true)
    expect(uncovered(marks)).toEqual([])
  })

  it("the mark vocabulary is pure geometry — no text, no CSS variable", () => {
    // A mark that renders a glyph is a font lookup again, and a mark that names
    // a CSS variable renders nothing at all (satori resolves neither). Both
    // failures are silent in a PNG, so they are asserted here rather than left
    // to a reviewer noticing.
    const src = rendered(path.join(process.cwd(), "lib/og/marks.tsx"))
    expect(src).not.toMatch(/var\(--/)
    expect(src).not.toMatch(/currentColor/)
    expect(src).not.toMatch(/<text\b/)
  })
})
