// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// next/link → plain anchor so we can read href without a router context.
vi.mock("next/link", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a>,
}))

import FeatureTabGate from "@/components/collection/FeatureTabGate"
import { PAGE_LABELS, getCollection } from "@/lib/collections"

// FeatureTabGate is the route-access gate for per-collection tabs: a direct URL
// to a tab a collection does NOT expose (e.g. /ufc/market) must render a
// graceful "not available" pointer, while a collection that DOES list the page
// gets a transparent pass-through. Tested against the REAL registry so a
// pages[] change surfaces here instead of being papered over by a fixture.

afterEach(() => cleanup())

describe("FeatureTabGate — pass-through", () => {
  it("renders children when the collection lists the page (nba-top-shot has market)", () => {
    const { container } = render(
      <FeatureTabGate id="nba-top-shot" page="market">
        <div data-testid="tab-body">MARKET BODY</div>
      </FeatureTabGate>
    )
    expect(container.querySelector('[data-testid="tab-body"]')).not.toBeNull()
    expect(container.textContent).not.toMatch(/isn't available/i)
  })
})

describe("FeatureTabGate — gated shell", () => {
  it("blocks a tab the collection does not expose (ufc has no market) and links back to overview", () => {
    const { container } = render(
      <FeatureTabGate id="ufc" page="market">
        <div data-testid="tab-body">SHOULD NOT RENDER</div>
      </FeatureTabGate>
    )
    // children are NOT rendered
    expect(container.querySelector('[data-testid="tab-body"]')).toBeNull()
    // the shell names the page + the collection
    const ufc = getCollection("ufc")!
    expect(container.textContent).toContain(PAGE_LABELS.market)
    expect(container.textContent).toContain(ufc.label)
    // the CTA points at this collection's overview
    const link = container.querySelector("a")
    expect(link?.getAttribute("href")).toBe("/ufc/overview")
  })

  it("falls back to a generic label + default overview link for an unknown collection id", () => {
    const { container } = render(
      <FeatureTabGate id="not-a-real-collection" page="sets">
        <div data-testid="tab-body">x</div>
      </FeatureTabGate>
    )
    expect(container.querySelector('[data-testid="tab-body"]')).toBeNull()
    expect(container.textContent).toContain("this collection")
    expect(container.textContent).toContain(PAGE_LABELS.sets)
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/not-a-real-collection/overview")
  })
})
