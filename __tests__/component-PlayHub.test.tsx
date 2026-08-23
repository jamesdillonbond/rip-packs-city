// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { readFileSync } from "node:fs"
import path from "node:path"
import PlayHub from "@/components/play/PlayHub"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// `components/play/` matched NO glob in `vitest.components.config.ts`'s curated
// 18-subtree `include`, so this 171-line component was invisible to the gate BY
// CONSTRUCTION and carried zero test references. Found 2026-08-20 while widening
// that include to a tree walk — the repo's own documented "a curated list drifts"
// failure, landing inside the gate's own config.
//
// ⚠ THE INVARIANT WORTH PINNING IS NOT A RENDER, IT IS A CROSS-FILE CORRESPONDENCE.
// PlayHub's `live` flag and the feature's `layout.tsx` are two halves of one
// decision, edited in different files. Its own header says so: "they render here
// as non-clickable 'Coming soon' cards until they're un-parked. When they go
// live, flip `live: true` on those entries and remove the redirect in their
// layout.tsx." Nothing checked that the two halves agreed. Both ways of
// disagreeing ship a defect:
//   * `live: true` while the layout still redirects → a card that looks open and
//     bounces the collector straight back to /overview.
//   * `live: false` after the redirect is removed → a shipped feature parked
//     behind a "Coming soon" badge nobody thinks to question.
//
// This is deliberately a SELF-RETIRING guard, in the shape
// `no-rewards-promises-while-unshipped` established: un-parking Fast Break does
// not require deleting this test, it requires flipping the flag the test is
// asking about. A guard that must be deleted before a feature can ship gets
// deleted in a hurry by someone who does not know why it existed.

const APP = path.resolve(__dirname, "..", "app", "(collections)", "[collection]")

/**
 * Does this feature's route layout bounce every visitor somewhere else?
 *
 * A missing layout is NOT a redirect — `challenges` has no layout at all, which
 * is what "live" looks like on this surface. Read the file rather than keeping a
 * list of parked slugs here: a list would be the same curated-list drift that
 * hid this component from the gate in the first place.
 */
function layoutRedirects(slug: string): boolean {
  let src: string
  try {
    src = readFileSync(path.join(APP, slug, "layout.tsx"), "utf8")
  } catch {
    return false
  }
  const code = stripComments(src)
  // Unconditional only: a redirect inside an `if` is a real page with a guard,
  // not a parked feature, and must not read as parked here.
  return /^\s*redirect\(/m.test(code)
}

afterEach(cleanup)

const FEATURES = ["challenges", "fast-break", "road-to-the-ring"] as const

describe("PlayHub — the live/parked flag must agree with the route's own layout", () => {
  it.each(FEATURES)("%s: a card is a link if and only if its route does not redirect away", (slug) => {
    render(<PlayHub collection="nba-top-shot" accent="#E03A2F" />)

    const parked = layoutRedirects(slug)
    const link = document.querySelector(`a[href="/nba-top-shot/${slug}"]`)

    if (parked) {
      expect(link, `${slug}'s layout redirects, so its card must not be a link`).toBeNull()
    } else {
      expect(link, `${slug}'s layout does not redirect, so its card must link through`).not.toBeNull()
    }
  })

  it("is not vacuous — the fixture contains both a live feature and a parked one", () => {
    // Without this, the whole suite above passes trivially the day someone parks
    // (or un-parks) everything, and the correspondence stops being tested while
    // still reading as three green cases.
    const parked = FEATURES.filter(layoutRedirects)
    expect(parked.length, "at least one parked feature").toBeGreaterThan(0)
    expect(parked.length, "at least one live feature").toBeLessThan(FEATURES.length)
  })

  it.each(FEATURES)("%s: the badge states the same thing the link does", (slug) => {
    render(<PlayHub collection="nba-top-shot" accent="#E03A2F" />)

    const parked = layoutRedirects(slug)
    const badges = screen.getAllByText(parked ? "Coming soon" : "Live")
    expect(badges.length).toBeGreaterThan(0)

    // ⚠ Assert the ABSENCE of the false claim, not merely the presence of the
    // true one: both badges render on this page at once, so "a 'Coming soon'
    // exists somewhere" is satisfied by a DIFFERENT card and would pass on the
    // defect. Tie the badge to its own card.
    const card = screen.getByText(titleFor(slug)).closest("div")
    expect(card?.textContent).toContain(parked ? "Coming soon" : "Live")
    expect(card?.textContent).not.toContain(parked ? "Live" : "Coming soon")
  })
})

function titleFor(slug: string): string {
  return { challenges: "Challenges", "fast-break": "Fast Break", "road-to-the-ring": "Road to the Ring" }[
    slug
  ] as string
}

describe("PlayHub — rendering", () => {
  it("scopes every href to the collection it was handed", () => {
    render(<PlayHub collection="nfl-all-day" accent="#00C853" />)

    const hrefs = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs) {
      expect(href, "a hard-coded /nba-top-shot link would send All Day readers to Top Shot").toMatch(
        /^\/nfl-all-day\//,
      )
    }
  })

  it("renders all three features with their blurbs", () => {
    render(<PlayHub collection="nba-top-shot" accent="#E03A2F" />)

    for (const slug of FEATURES) expect(screen.getByText(titleFor(slug))).toBeTruthy()
    expect(screen.getByText(/ranked by net EV/)).toBeTruthy()
    expect(screen.getByText(/optimal Fast Break lineup/)).toBeTruthy()
    expect(screen.getByText(/Lock ROI calculator/)).toBeTruthy()
  })

  it("uses the accent it was passed rather than a hardcoded brand red", () => {
    // `#E03A2F` and `Barlow Condensed` are never hardcoded in this repo — they
    // come from the tokens in `app/rpc-tokens.css` or, as here, from a prop, so
    // a non-Top-Shot collection gets its own accent.
    render(<PlayHub collection="ufc-strike" accent="rgb(1, 2, 3)" />)

    const cta = screen.getByText(/Open Challenges/)
    expect(cta.getAttribute("style")).toContain("rgb(1, 2, 3)")
  })

  it("marks a parked card aria-disabled so it is not merely visually dimmed", () => {
    render(<PlayHub collection="nba-top-shot" accent="#E03A2F" />)

    const parked = FEATURES.filter(layoutRedirects)
    const disabled = document.querySelectorAll("[aria-disabled]")
    expect(disabled.length).toBe(parked.length)
  })
})
