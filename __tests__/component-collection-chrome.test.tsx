// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, within } from "@testing-library/react"

// collection-chrome.tsx renders the shared collection header chrome (ticker +
// breadcrumb/header/tabs banner) mounted by BOTH the generic [collection]/layout
// and the bespoke Pinnacle layout. The visible output is otherwise pure
// presentation, but it carries three real branches that only a test can pin:
//   1. CollectionTicker's items fall back to nba-top-shot for any unknown
//      collection id (an unmapped collection must never render an empty ticker),
//      and every item is DOUBLED so the marquee loops seamlessly.
//   2. CollectionBanner's release-stage badge styles ALPHA red but every other
//      badge in the collection accent — and renders nothing when badge is unset.
//   3. CollectionBanner maps collection.chain through chainLabel, falling back to
//      the raw chain string for an unmapped value.
//
// The banner composes four client children (CollectionSwitcher, CollectionTabBar,
// CollectionHeading, AnonSignInPill) that each call usePathname / the supabase
// browser client on mount. We stub them to inert markers so these tests exercise
// the banner's OWN logic in isolation rather than the children's data seams.

vi.mock("@/components/CollectionSwitcher", () => ({
  default: () => <div data-testid="switcher" />,
}))
vi.mock("@/components/collection-tab-bar", () => ({
  CollectionTabBar: () => <div data-testid="tab-bar" />,
}))
vi.mock("@/components/CollectionHeading", () => ({
  default: ({ collection }: { collection: { label: string } }) => (
    <div data-testid="heading">{collection.label}</div>
  ),
}))
vi.mock("@/components/AnonSignInPill", () => ({
  default: () => <div data-testid="anon-pill" />,
}))

import { CollectionTicker, CollectionBanner } from "@/components/collection-chrome"
import { getCollection, type Collection } from "@/lib/collections"

const TOPSHOT = getCollection("nba-top-shot")!
const UFC = getCollection("ufc")! // carries a BETA badge in the registry
const PANINI = getCollection("panini-blockchain")! // chain: "panini"

afterEach(() => cleanup())

describe("CollectionTicker — items + marquee doubling", () => {
  it("renders a collection's own ticker items, each doubled for a seamless loop", () => {
    const { container } = render(<CollectionTicker collection={TOPSHOT} />)
    // The LIVE pill anchors the ticker.
    expect(container.textContent).toContain("LIVE")
    // nba-top-shot has 5 mapped items; the marquee renders [...items, ...items].
    const spans = container.querySelectorAll("span")
    expect(spans.length).toBe(10)
    // A representative item appears (and appears twice, from the doubling).
    const analyzerCount = Array.from(spans).filter((s) =>
      s.textContent?.includes("COLLECTION ANALYZER"),
    ).length
    expect(analyzerCount).toBe(2)
  })

  it("keeps each collection's distinct copy (Golazos uses the ⚽ set)", () => {
    const golazos = getCollection("laliga-golazos")!
    const { container } = render(<CollectionTicker collection={golazos} />)
    expect(container.textContent).toContain("⚽")
    expect(container.textContent).toContain("100x-floor")
  })

  it("falls back to the nba-top-shot item set for an unmapped collection id", () => {
    // A collection with no TICKER_ITEMS entry must not render an empty marquee.
    const unknown = { ...TOPSHOT, id: "totally-unmapped-collection" } as Collection
    const { container } = render(<CollectionTicker collection={unknown} />)
    const spans = container.querySelectorAll("span")
    // Falls through to the 5-item nba-top-shot set (→ 10 doubled spans), NOT empty.
    expect(spans.length).toBe(10)
    expect(container.textContent).toContain("COLLECTION ANALYZER")
  })
})

describe("CollectionBanner — badge branch", () => {
  it("renders no release-stage badge when the collection has none", () => {
    const { container } = render(<CollectionBanner collection={TOPSHOT} />)
    expect(container.textContent).not.toContain("BETA")
    expect(container.textContent).not.toContain("ALPHA")
  })

  it("renders a BETA badge styled in the collection accent (not red)", () => {
    const { container } = render(<CollectionBanner collection={UFC} />)
    const badge = within(container as HTMLElement).getByText("BETA")
    // Non-ALPHA badges use the collection accent, never the red brand token.
    // (jsdom serializes the hex accent to rgba(), so we key on the ALPHA-only
    // var(--rpc-red) token being ABSENT rather than matching the raw accent hex.)
    expect(badge.getAttribute("style")).not.toContain("var(--rpc-red)")
  })

  it("styles an ALPHA badge with the red brand token", () => {
    const alpha = { ...TOPSHOT, badge: "ALPHA" } as Collection
    const { container } = render(<CollectionBanner collection={alpha} />)
    const badge = within(container as HTMLElement).getByText("ALPHA")
    expect(badge.getAttribute("style")).toContain("var(--rpc-red)")
  })
})

describe("CollectionBanner — chain label mapping", () => {
  it("maps a known chain to its display label", () => {
    const { container } = render(<CollectionBanner collection={TOPSHOT} />)
    expect(container.textContent).toContain("Flow") // chain "flow" → "Flow"
  })

  // 2026-09-06: the pill reads the REAL network (`dbChain`) when the registry
  // names one, and only falls back to the roadmap tag. "candy" once rendered
  // "Root Network" — a chain the registry itself records as dead.
  it("renders the real network from dbChain — Panini's bridge plane is Ethereum, Candy is Solana", () => {
    const { container } = render(<CollectionBanner collection={PANINI} />)
    expect(container.textContent).toContain("Ethereum") // dbChain "ethereum" wins over chain "panini"
    expect(container.textContent).not.toContain("Panini Chain")
    const candy = { ...TOPSHOT, id: "candy-mlb", chain: "candy", dbChain: "solana" } as any as Collection
    const { container: c2 } = render(<CollectionBanner collection={candy} />)
    expect(c2.textContent).toContain("Solana")
    expect(c2.textContent).not.toContain("Root Network")
  })

  it("falls back to the roadmap tag, then the raw string, when no dbChain is set", () => {
    const weird = { ...TOPSHOT, chain: "moonbeam" as any, dbChain: null } as Collection
    const { container } = render(<CollectionBanner collection={weird} />)
    // chainLabel has no "moonbeam" key → renders the raw value verbatim.
    expect(container.textContent).toContain("moonbeam")
  })
})

describe("CollectionBanner — composition", () => {
  it("mounts the breadcrumb, heading, switcher, tab bar, and anon pill", () => {
    const { container, getByTestId } = render(<CollectionBanner collection={TOPSHOT} />)
    // Breadcrumb: the RPC home link + the collection label.
    expect(container.querySelector('a[href="/"]')?.textContent).toBe("RPC")
    expect(getByTestId("heading").textContent).toBe(TOPSHOT.label)
    expect(getByTestId("switcher")).toBeTruthy()
    expect(getByTestId("tab-bar")).toBeTruthy()
    expect(getByTestId("anon-pill")).toBeTruthy()
  })
})
