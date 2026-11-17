// The home page must declare its own canonical, and must do it WITHOUT taking
// the two footguns that make the fix worse than the gap.
//
// ── The gap, measured on the served HTML 2026-08-23 ────────────────────────
//   GET /  →  canonical: none · og:url: none
//   link rels present: stylesheet, preload, icon, apple-touch-icon, preconnect,
//                      dns-prefetch
// Every other surface checked carries one (`/insights`, `/insights/pack-sniper`,
// an edition page, a Pinnacle pin page, a pack-dist page). `rootMetadata` sets
// metadataBase/title/openGraph/twitter but no `alternates`, and `app/page.tsx`
// exported no metadata of its own, so home inherited the gap.
//
// ── The two footguns, which are why this guard has three cases ─────────────
// 1. 🚨 A canonical on `rootMetadata` would be INHERITED by every descendant
//    that does not set its own, pointing a pile of pages at the homepage. That
//    is strictly WORSE than no canonical at all, and it would satisfy any naive
//    "the home page has a canonical" assertion.
// 2. ⚠ `openGraph`/`twitter` merge SHALLOWLY (lib/seo.ts). A page-level metadata
//    export that redefines either REPLACES the root object and silently drops
//    siteName / type / locale / creator.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const HOME = join(process.cwd(), "app", "page.tsx")
const SEO = join(process.cwd(), "lib", "seo.ts")

const home = () => stripComments(readFileSync(HOME, "utf8"))

describe("the home page declares its own canonical", () => {
  it("app/page.tsx exports metadata with an explicit canonical", () => {
    expect(home(), "app/page.tsx must export its own metadata").toMatch(
      /export const metadata: Metadata/,
    )
    expect(home(), "…carrying alternates.canonical").toMatch(
      /alternates:\s*\{\s*canonical:\s*["'`]\/["'`]\s*\}/,
    )
  })

  it("🚨 rootMetadata must NOT carry alternates — it would be inherited site-wide", () => {
    // The whole reason the fix is scoped to app/page.tsx. A `canonical` on the
    // root object points every page that does not override it at the homepage.
    const src = stripComments(readFileSync(SEO, "utf8"))
    const start = src.indexOf("rootMetadata")
    expect(start, "could not locate rootMetadata — renamed?").toBeGreaterThan(-1)
    // Bound the window to the object literal rather than scanning the whole file,
    // which defines `alternates` legitimately in the per-page builders below.
    const block = src.slice(start, start + 1200)
    expect(
      block,
      "rootMetadata carries alternates — every descendant without its own canonical would inherit it",
    ).not.toMatch(/alternates\s*:/)
  })

  it("⚠ a redefined openGraph must carry BOTH inherited halves — they merge SHALLOWLY", () => {
    // ── INVERTED 2026-08-28, NOT DELETED ──────────────────────────────────
    // This case used to read "the home export must not redefine openGraph",
    // reasoning: "Adding og:url here would REPLACE the root openGraph object and
    // drop siteName/type/locale, which is a bigger regression than the missing
    // tag." The PROPERTY it protects — the root's fields must not be dropped —
    // is unchanged and still worth pinning. Only its PROXY ("never redefine the
    // key at all") is obsolete: that was the correct conservative spelling while
    // no safe way to restate the block existed, and it also froze the `og:url`
    // gap in place, since satisfying it and emitting og:url were incompatible.
    //
    // Two things made a safe redefinition possible: OG_INHERITED was exported
    // (08-17), and ROOT_OG_CONTENT now holds the title/description/images half.
    // Home spreads both, so it restates nothing and cannot drift from the root.
    // Asserting the SPREADS rather than the absence of the key is what keeps the
    // original regression caught — a hand-rolled block that drops siteName now
    // fails here exactly as it did before.
    const block = home().slice(home().indexOf("export const metadata: Metadata"))
    const og = /openGraph\s*:/.test(block)
    if (og) {
      expect(
        block,
        "home redefines openGraph but does not spread OG_INHERITED — this DROPS siteName/type/locale from the root block",
      ).toMatch(/\.\.\.\s*OG_INHERITED\b/)
      expect(
        block,
        "…and does not spread ROOT_OG_CONTENT — this DROPS the root title/description/images",
      ).toMatch(/\.\.\.\s*ROOT_OG_CONTENT\b/)
      expect(
        block,
        "…redefining openGraph without og:url gains nothing — that tag is the only reason to redefine it",
      ).toMatch(/\burl\s*:\s*["'`]\/["'`]/)
    }
    // `twitter` has no equivalent per-page field to add, so the original
    // never-redefine rule still binds there and stays as-is.
    expect(block, "the page-level metadata export must not redefine twitter").not.toMatch(
      /twitter\s*:/,
    )
  })

  it("emits og:url — the 08-23 gap this file's third case used to hold open", () => {
    // A ban that is vacuous at population zero punishes its own success, so this
    // asserts the POSITIVE: the tag is actually declared. Without it, reverting
    // app/page.tsx to the alternates-only export would leave every case above
    // green (the block above is guarded on `og`) and silently reopen the gap.
    const block = home().slice(home().indexOf("export const metadata: Metadata"))
    expect(block, "home must declare openGraph.url so GET / emits og:url").toMatch(
      /openGraph\s*:\s*\{[^}]*\burl\s*:\s*["'`]\/["'`]/,
    )
  })
})
