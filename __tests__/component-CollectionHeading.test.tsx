// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// CollectionHeading decides whether the collection banner's title is a real <h1> or a
// plain styled <div>. That decision is load-bearing SEO/a11y and is invisible on screen —
// the two branches render identical pixels — so nothing but a test can catch a regression.
//
// Measured 2026-07-28 against server-rendered HTML: /{collection}/{overview,collection,
// market,sets} shipped 0 h1 AND 0 h2 across ~5 collections x 6 tabs, the site's
// highest-traffic surface. The naive fix (hardcode <h1> in the banner) REGRESSES the
// pages that are already right: the same banner is mounted by [collection]/layout.tsx
// over every entity route, and those already render their own specific h1.

const state = vi.hoisted(() => ({ pathname: "/nba-top-shot/overview" }))

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
}))

import CollectionHeading from "@/components/CollectionHeading"
import { getCollection } from "@/lib/collections"

// Real registry entries (pure) rather than hand-rolled fixtures, so a registry shape
// change surfaces here instead of being papered over by a stub.
const COLLECTION = getCollection("nba-top-shot")!
const PINNACLE = getCollection("disney-pinnacle")!

// Queries are scoped to each render's OWN container, and every render is torn down after
// the case. This harness does not auto-cleanup, so a document-wide `querySelector("h1")`
// would keep finding the FIRST h1 any earlier case left mounted — every negative
// assertion here would then pass or fail for the wrong reason.
const headingIn = (container: HTMLElement) => container.querySelector("h1")

beforeEach(() => {
  state.pathname = "/nba-top-shot/overview"
})
afterEach(() => cleanup())

describe("CollectionHeading — tab routes get the <h1> they were missing", () => {
  it.each([
    ["/nba-top-shot/overview", "Overview"],
    ["/nba-top-shot/collection", "Collection"],
    ["/nba-top-shot/market", "Market"],
    ["/nba-top-shot/analytics", "Analytics"],
    ["/nba-top-shot/packs", "Packs"],
    ["/nba-top-shot/play", "Play"],
  ])("renders an h1 on %s", (path, tabLabel) => {
    state.pathname = path
    const { container } = render(<CollectionHeading collection={COLLECTION} />)
    const h1 = headingIn(container)
    expect(h1).not.toBeNull()
    // The collection label stays the VISIBLE text — this is a semantics fix, not a
    // redesign — with the tab carried in an sr-only span so the h1 still matches that
    // tab's own distinct <title> instead of repeating across all six tabs.
    expect(h1!.textContent).toContain(COLLECTION.label)
    expect(h1!.textContent).toContain(tabLabel)
    expect(h1!.querySelector(".sr-only")?.textContent).toContain(tabLabel)
  })

  it("renders an h1 with no tab suffix on the bare collection root", () => {
    state.pathname = "/nba-top-shot"
    const { container } = render(<CollectionHeading collection={COLLECTION} />)
    expect(headingIn(container)).not.toBeNull()
    expect(headingIn(container)!.querySelector(".sr-only")).toBeNull()
  })
})

describe("CollectionHeading — never competes with a page that owns its h1", () => {
  // 3+ segments. These pages render their own specific h1 ("LeBron James", the edition
  // name, …); a generic collection-label h1 here would sit AHEAD of it in the DOM and
  // dilute the strongest title signal on the pages that currently get it right.
  it.each([
    "/nba-top-shot/edition/some-edition-slug",
    "/nba-top-shot/moment/12345",
    "/nba-top-shot/player/lebron-james",
    "/nba-top-shot/team/portland-trail-blazers",
    "/nba-top-shot/set/base-set",
    "/nba-top-shot/series/series-4",
    "/nba-top-shot/pack/dist/8537",
    "/nba-top-shot/profile/jamesdillonbond",
  ])("renders a div, not an h1, on the entity route %s", (path) => {
    state.pathname = path
    const { container } = render(<CollectionHeading collection={COLLECTION} />)
    expect(headingIn(container)).toBeNull()
    expect(container.firstElementChild!.tagName).toBe("DIV")
    expect(container.textContent).toContain(COLLECTION.label)
  })

  // 2 segments, but these six tab pages render their own h1. Verified by grep
  // 2026-07-28; `sniper` also covers the bespoke Disney Pinnacle sniper page, which is
  // why the rule keys on the tab SEGMENT rather than the full path.
  it.each(["sniper", "sets", "challenges", "hot-floors", "fast-break", "road-to-the-ring"])(
    "renders a div, not an h1, on the self-headed tab /%s",
    (tab) => {
      state.pathname = `/nba-top-shot/${tab}`
      const { container } = render(<CollectionHeading collection={COLLECTION} />)
      expect(headingIn(container)).toBeNull()
    },
  )

  it("applies the exclusion to every collection, incl. the bespoke Pinnacle sniper page", () => {
    state.pathname = "/disney-pinnacle/sniper"
    const { container } = render(<CollectionHeading collection={PINNACLE} />)
    expect(headingIn(container)).toBeNull()
  })
})

describe("CollectionHeading — visual parity between the two branches", () => {
  // The whole premise is that promoting the tag changes nothing on screen. An <h1>
  // carries a UA margin the <div> did not, so margin:0 must be pinned explicitly.
  it("renders both branches with identical inline styles and no UA margin", () => {
    state.pathname = "/nba-top-shot/overview"
    const { container: withH1 } = render(<CollectionHeading collection={COLLECTION} />)
    const h1 = withH1.querySelector("h1")!
    const h1Style = h1.getAttribute("style")
    const h1Margin = h1.style.margin
    cleanup()

    state.pathname = "/nba-top-shot/edition/x"
    const { container: withDiv } = render(<CollectionHeading collection={COLLECTION} />)
    const div = withDiv.querySelector("div")!

    expect(h1Style).toBe(div.getAttribute("style"))
    expect(h1Margin).toBe("0px")
  })
})
