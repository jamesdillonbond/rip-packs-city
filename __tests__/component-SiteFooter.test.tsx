// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { readFileSync } from "node:fs"

// SiteFooter — measured at 0% statements before this file, despite mounting on
// every page of the site (all ~18K entity pages, overview, home).
//
// Its logic is not decorative: the /insights link list is LAUNCH-FLAG GATED, and
// the failure mode is specific and silent. `proxy.ts` does not 404 a gated
// route — it 302s to /login and the crawler gets an HTML login page AT STATUS
// 200 (CLAUDE.md records this as how /fonts/*.ttf stayed broken for weeks). So a
// footer that links a STAGED board points every page on the site at a login
// wall while every naive "did it respond?" check passes.
//
// The two flags also fan out to four other consumers each (proxy route wall,
// sitemap, /insights hub card, the surface layout's robots), so this pins the
// footer's half of that contract: the link list must track the flag, in BOTH
// directions.

import SiteFooter from "@/components/SiteFooter"
import { CANDY_MLB_PUBLIC, PANINI_PUBLIC } from "@/lib/launch-flags"
import { publishedCollections, publishedChainsBadge } from "@/lib/collections"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

afterEach(cleanup)

function hrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "")
}

describe("SiteFooter — staged boards are never linked site-wide", () => {
  it("links the Candy board only while CANDY_MLB_PUBLIC is true", () => {
    const { container } = render(<SiteFooter />)
    // Asserted in both directions against the live flag rather than a hardcoded
    // expectation: a flag flip is a one-line, deliberately atomic change, and a
    // test that hardcodes today's value would red on the flip itself instead of
    // on a real regression.
    expect(hrefs(container).includes("/insights/candy-mlb")).toBe(CANDY_MLB_PUBLIC)
  })

  it("links the Panini board only while PANINI_PUBLIC is true", () => {
    const { container } = render(<SiteFooter />)
    expect(hrefs(container).includes("/insights/panini-squeeze")).toBe(PANINI_PUBLIC)
  })

  it("keeps both staged links behind their flag in SOURCE", () => {
    // ⚠ THE RUNTIME ASSERTIONS ABOVE CANNOT PROVE THIS while the flags are
    // `true`: gated and ungated render byte-identically, so deleting the
    // `CANDY_MLB_PUBLIC ? … : []` guard passes them 6/6 (verified by mutation).
    // They only bite after a flag flips back to false — i.e. exactly when the
    // board has been un-published and the damage is already live.
    //
    // A flip to false is a rollback, and rollback is when this matters most: an
    // ungated footer would then point all ~18K pages at a board that 302s to
    // /login and answers 200 with login HTML, which no status check catches.
    const src = stripComments(readFileSync("components/SiteFooter.tsx", "utf8"))
    for (const [flag, href] of [
      ["CANDY_MLB_PUBLIC", "/insights/candy-mlb"],
      ["PANINI_PUBLIC", "/insights/panini-squeeze"],
    ] as const) {
      expect(src, `${href} must be linked only inside a ${flag} guard`).toMatch(
        new RegExp(String.raw`${flag}\s*\?[^\n]*${href.replace(/\//g, "\\/")}`),
      )
    }
  })

  it("always links the boards that are unconditionally public", () => {
    // Not vacuous: if the whole INSIGHTS_LINKS list were dropped, the flag
    // assertions above would still pass whenever both flags are true-and-absent
    // or false-and-absent. These are the entries that must never depend on a flag.
    const h = hrefs(render(<SiteFooter />).container)
    for (const href of [
      "/insights",
      "/insights/squeeze",
      "/insights/deals",
      "/insights/first-mint",
      "/insights/rookies",
      "/insights/market",
      "/insights/pack-reality",
      "/insights/pack-sniper",
    ]) {
      expect(h, `footer must link ${href}`).toContain(href)
    }
  })
})

describe("SiteFooter — collection links come from the registry", () => {
  it("links every published collection's overview, and no unpublished one", () => {
    const { container } = render(<SiteFooter />)
    const h = hrefs(container)
    const published = publishedCollections()
    expect(published.length).toBeGreaterThan(0)
    for (const c of published) {
      expect(h, `footer must link /${c.id}/overview`).toContain(`/${c.id}/overview`)
    }
    // The mirror: an unpublished collection has no /[collection]/… routes at
    // all, so a footer link to one is a site-wide 404 (or a login wall).
    const publishedIds = new Set(published.map((c) => c.id))
    const collectionOverviewLinks = h.filter((x) => /^\/[a-z0-9-]+\/overview$/.test(x))
    for (const link of collectionOverviewLinks) {
      expect(publishedIds, `${link} is linked but not published`).toContain(link.split("/")[1])
    }
  })

  it("renders the current chain attribution badge", () => {
    const { container } = render(<SiteFooter />)
    const badge = publishedChainsBadge()
    expect(badge).toBeTruthy()
    expect(container.textContent).toContain(badge)
  })

  it("derives that badge from the registry rather than hardcoding a chain", () => {
    // ⚠ A SOURCE assertion deliberately, because the runtime one above CANNOT
    // prove this: `publishedChainsBadge()` returns exactly "BUILT ON FLOW"
    // today, so replacing the call with that literal is invisible to any
    // rendered-output check — verified by mutation, which passed 5/5.
    //
    // It matters because the badge is provenance: it becomes "BUILT ON FLOW +
    // SOLANA" the day the candy-mlb registry entry publishes, and a hardcoded
    // literal would leave every page on the site footer-claiming Flow for a
    // Solana-backed board. That exact defect (P4) is why the helper exists.
    const src = stripComments(readFileSync("components/SiteFooter.tsx", "utf8"))
    expect(src, "SiteFooter must call publishedChainsBadge()").toMatch(/publishedChainsBadge\(\)/)
    expect(src, "SiteFooter must not hardcode a BUILT ON <chain> string").not.toMatch(
      /["'`]BUILT ON /i,
    )
  })
})
