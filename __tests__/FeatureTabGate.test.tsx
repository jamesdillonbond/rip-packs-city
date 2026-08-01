// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import FeatureTabGate from "@/components/collection/FeatureTabGate"

// FeatureTabGate is the route-gating shell: when a collection exposes the page
// it's a transparent pass-through; when it doesn't (e.g. /ufc/market,
// /disney-pinnacle/sets) it renders a graceful "not available" pointer instead
// of a broken/empty core tab. Both branches matter — a pass-through regression
// would hide a real tab; a gate regression would render an empty core tab.

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

  it("gates a second collection/page pair the same way (disney-pinnacle lacks sets)", () => {
    const { queryByTestId, getByText } = render(
      <FeatureTabGate id="disney-pinnacle" page={"sets" as never}>
        <div data-testid="tab-content">real tab</div>
      </FeatureTabGate>,
    )
    expect(queryByTestId("tab-content")).toBeNull()
    const back = getByText(/Back to Overview/i) as HTMLAnchorElement
    expect(back.getAttribute("href")).toBe("/disney-pinnacle/overview")
  })
})
