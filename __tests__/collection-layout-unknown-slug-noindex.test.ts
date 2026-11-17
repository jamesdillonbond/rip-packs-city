/**
 * An unresolvable `[collection]` segment must not publish an INDEXABLE,
 * SELF-CANONICAL duplicate.
 *
 * Measured live 2026-08-15, before the fix:
 *
 *   GET /totally-bogus-slug/overview
 *     -> 200
 *        canonical = https://www.rippackscity.com/totally-bogus-slug/overview
 *        robots    = index, follow
 *        h1        = "NBA Top Shot — Overview"   (26 $-figures, real market data)
 *
 * `pageMetadata` builds `canonical` from the raw route segment, which is
 * unvalidated user input, so every unresolvable slug minted its own canonical
 * copy of one page — an unbounded indexable duplicate set on a project whose
 * roadmap rests on SEO.
 *
 * ⚠ Only `/overview` is anonymously reachable with an arbitrary segment (the
 * proxy opens /^\/[^/]+\/overview$/ for ANY segment; the other tabs open only
 * for the 5 published slugs, verified live — /bogus/market and six siblings all
 * 307 to /login). The other seven layouts are therefore LATENT, not safe:
 * /overview was gated too until the 2026-07-17 soft launch un-gated it. This
 * guard is directory-driven so a ninth layout is covered the day it lands.
 */
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { pageMetadata, unknownCollectionMetadata } from "@/lib/seo"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const DIR = path.join(process.cwd(), "app", "(collections)", "[collection]")

/** Strip comments first — this repo has shipped four guards that tripped on
 *  their own explanatory comment quoting the very string they ban. */

function layoutsWithUnknownSlugFallback(): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const f = path.join(DIR, entry.name, "layout.tsx")
    if (!fs.existsSync(f)) continue
    const src = stripComments(fs.readFileSync(f, "utf8"))
    if (/if\s*\(!collection\)/.test(src)) out.push(f)
  }
  return out
}

describe("unresolvable [collection] slug must not be indexable", () => {
  const layouts = layoutsWithUnknownSlugFallback()

  it("finds the layout family (guard is not vacuous)", () => {
    expect(layouts.length).toBeGreaterThanOrEqual(8)
  })

  it.each(layouts.map((f) => [path.relative(DIR, f), f] as const))(
    "%s routes its unknown-slug fallback through unknownCollectionMetadata",
    (_rel, file) => {
      const src = stripComments(fs.readFileSync(file, "utf8"))
      expect(src).toContain("unknownCollectionMetadata")
      // The old shape minted a self-canonical indexable page. It must be gone.
      expect(src).not.toMatch(/pageMetadata\(\s*"[a-z-]+"\s*,\s*"Flow"/)
    }
  )

  // ── Behaviour, not just spelling ──────────────────────────────────────────
  it("unknownCollectionMetadata is noindex (and still follows out-links)", () => {
    const m = unknownCollectionMetadata("overview", "totally-bogus-slug")
    expect(m.robots).toMatchObject({ index: false, follow: true })
  })

  it("still carries a title/description so the fallback renders sanely", () => {
    const m = unknownCollectionMetadata("overview", "totally-bogus-slug")
    expect(m.title).toBeTruthy()
    expect(m.description).toBeTruthy()
  })

  /**
   * ⚠ THE MIRROR, and the one that matters most: a RESOLVED collection must NOT
   * be noindexed. Blanket-noindexing this family would de-index the five
   * published collections' primary landing pages — strictly worse than the
   * duplicate problem it fixes.
   */
  it("a real collection is NOT noindexed", () => {
    const m = pageMetadata("overview", "NBA Top Shot", "nba-top-shot")
    expect(m.robots).toBeUndefined()
    expect(m.alternates?.canonical).toContain("/nba-top-shot/overview")
  })
})
