// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import FeatureTabGate from "@/components/collection/FeatureTabGate"
import { publishedCollections, PAGE_LABELS, type CollectionPage } from "@/lib/collections"

const ALL_PAGES = Object.keys(PAGE_LABELS) as CollectionPage[]

// FeatureTabGate is the route-gating shell: when a collection exposes the page
// it's a transparent pass-through; when it doesn't (e.g. /ufc/market) it renders
// a graceful "not available" pointer instead of a broken/empty core tab. Both
// branches matter — a pass-through regression would hide a real tab; a gate
// regression would render an empty core tab.
// ⚠ /disney-pinnacle/sets used to be this file's second example and is now a
// REAL tab (2026-09-20) — see the re-pin note below before reaching for it.

afterEach(() => cleanup())

describe("FeatureTabGate", () => {
  it("passes children through when the collection HAS the page", () => {
    // nba-top-shot exposes "market".
    const { getByTestId, queryByText } = render(
      <FeatureTabGate id="nba-top-shot" page={"market" as never}>
        <div data-testid="tab-content">real tab</div>
      </FeatureTabGate>,
    )
    expect(getByTestId("tab-content").textContent).toBe("real tab")
    expect(queryByText(/isn't available/i)).toBeNull()
    expect(queryByText(/Back to Overview/i)).toBeNull()
  })

  it("renders the graceful fallback when the collection LACKS the page", () => {
    // ufc does NOT expose "market".
    const { queryByTestId, getByText } = render(
      <FeatureTabGate id="ufc" page={"market" as never}>
        <div data-testid="tab-content">real tab</div>
      </FeatureTabGate>,
    )
    expect(queryByTestId("tab-content")).toBeNull()
    expect(getByText(/isn't available/i)).toBeTruthy()
    const back = getByText(/Back to Overview/i) as HTMLAnchorElement
    // The fallback CTA points at the collection's overview tab.
    expect(back.getAttribute("href")).toBe("/ufc/overview")
  })

  // ⚠ RE-PINNED 2026-09-20, and the reason matters more than the new value.
  // This arm used to be `disney-pinnacle` + `sets` — and it went green for the
  // WRONG reason the moment Pinnacle gained the Sets tab, because its whole job
  // is to prove the gate is not hardcoded to the ufc/market pair above. A pair
  // that no longer holds stops exercising the gate at all.
  //
  // So the pair is now DERIVED from the registry rather than spelled: the first
  // published collection/page combination that genuinely does not exist. It
  // cannot rot the same way, and the vacuity guard below fails loudly on the day
  // every collection exposes every page (at which point delete this arm rather
  // than let it pass empty).
  const MISSING_PAIR = (() => {
    for (const c of publishedCollections()) {
      if (c.id === "ufc") continue // the arm above already owns this one
      for (const page of ALL_PAGES) {
        if (!c.pages.includes(page)) return { id: c.id, page }
      }
    }
    return null
  })()

  it("has a second collection/page pair to gate at all", () => {
    expect(
      MISSING_PAIR,
      "every published collection exposes every page — this arm is now vacuous, delete it",
    ).not.toBeNull()
  })

  it("gates a second collection/page pair the same way", () => {
    const pair = MISSING_PAIR!
    const { queryByTestId, getByText } = render(
      <FeatureTabGate id={pair.id} page={pair.page as never}>
        <div data-testid="tab-content">real tab</div>
      </FeatureTabGate>,
    )
    expect(queryByTestId("tab-content")).toBeNull()
    const back = getByText(/Back to Overview/i) as HTMLAnchorElement
    expect(back.getAttribute("href")).toBe(`/${pair.id}/overview`)
  })

  // The other half of the same change: Pinnacle's Sets tab is now a real tab,
  // so the gate must be a TRANSPARENT PASS-THROUGH for it. Without this, a
  // registry revert would silently soft-404 the surface again and only the
  // (now derived) arm above would move.
  it("passes Disney Pinnacle's Sets tab straight through", () => {
    const { getByTestId, queryByText } = render(
      <FeatureTabGate id="disney-pinnacle" page={"sets" as never}>
        <div data-testid="tab-content">real tab</div>
      </FeatureTabGate>,
    )
    expect(getByTestId("tab-content").textContent).toBe("real tab")
    expect(queryByText(/isn't available/i)).toBeNull()
  })
})
