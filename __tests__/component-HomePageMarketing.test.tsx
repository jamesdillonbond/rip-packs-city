// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import HomePageMarketing from "@/components/HomePageMarketing"
import { publishedCollections } from "@/lib/collections"

// Light render test for the anonymous marketing landing (largely presentational):
// the home_view funnel beacon on mount, the <h1>, the WebSite JSON-LD block, a
// published-collection card, and a signin_click funnel beacon on the header CTA.
// The heavy children (WalletSearch/HomeFmvPreview/etc.) are stubbed to markers so
// this exercises HomePageMarketing's own code, not their fetch machinery.

const funnelMock = vi.fn()
vi.mock("@/lib/track-funnel", () => ({ trackFunnelEvent: (...a: unknown[]) => funnelMock(...a) }))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))
vi.mock("@/components/WalletSearch", () => ({ default: () => <div data-testid="wallet-search" /> }))
vi.mock("@/components/HomeFmvPreview", () => ({ default: () => <div data-testid="home-fmv-preview" /> }))
vi.mock("@/components/SiteFooter", () => ({ default: () => <div data-testid="site-footer" /> }))
vi.mock("@/components/MobileNav", () => ({ default: () => <div data-testid="mobile-nav" /> }))
vi.mock("@/components/RpcLogo", () => ({ default: () => <div data-testid="rpc-logo" /> }))
vi.mock("@/components/visual/PinwheelDivider", () => ({ default: () => <div data-testid="pinwheel" /> }))

beforeEach(() => funnelMock.mockClear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("HomePageMarketing", () => {
  it("fires the home_view funnel beacon once on mount", () => {
    render(<HomePageMarketing />)
    expect(funnelMock).toHaveBeenCalledWith({ eventType: "home_view", surface: "home" })
    const homeViews = funnelMock.mock.calls.filter((c) => c[0]?.eventType === "home_view")
    expect(homeViews.length).toBe(1)
  })

  it("renders the h1 and the WebSite JSON-LD block", () => {
    const { getByRole, container } = render(<HomePageMarketing />)
    const ld = container.querySelector('script[type="application/ld+json"]')
    expect(ld).toBeTruthy()
    expect(ld!.textContent).toContain("rippackscity.com")

    // The h1 is the SEARCHED QUESTION, not the brand name (changed 2026-08-01).
    // This assertion previously pinned "Rip Packs", which is why it caught the
    // swap — keep it pinned to the *intent* (the value question) rather than to
    // exact marketing copy, so a wording tweak doesn't red CI but a silent
    // regression back to a brand-name h1 does.
    const h1 = getByRole("heading", { level: 1 }).textContent ?? ""
    expect(h1.toLowerCase()).toContain("worth")
    expect(h1.toLowerCase()).not.toContain("rip packs")
  })

  it("renders a card for each published collection", () => {
    const { container } = render(<HomePageMarketing />)
    const labels = publishedCollections().map((c) => c.label)
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) {
      expect(container.textContent).toContain(label)
    }
  })

  it("the header sign-in CTA fires a signin_click funnel beacon", () => {
    const { getAllByText } = render(<HomePageMarketing />)
    // there are sign-in CTAs in the header and pricing; the header one is first
    const cta = getAllByText(/sign in/i)[0]
    fireEvent.click(cta)
    expect(funnelMock).toHaveBeenCalledWith({ eventType: "signin_click", surface: "home_header" })
  })
})

// 2026-09-02 (onboarding QA #8): the campaign's ask is "build a trophy case"
// and the landing page never said the words. The block shows a REAL case (the
// OG card a share link unfurls into), not a mock-up.
describe("HomePageMarketing — the trophy-case block", () => {
  it("names the trophy case, shows a real card, and sends new users to /login", () => {
    const { container } = render(<HomePageMarketing />)
    const block = container.querySelector("[data-home-trophy-case]") as HTMLElement
    expect(block).toBeTruthy()
    expect(block.textContent).toMatch(/build your trophy case/i)
    const img = block.querySelector("img") as HTMLImageElement
    expect(img.getAttribute("src")).toMatch(/^\/api\/og\/trophy-case\//)
    expect(img.getAttribute("alt")).toMatch(/trophy case/i)
    const cta = Array.from(block.querySelectorAll("a")).find((a) => /build yours/i.test(a.textContent ?? ""))
    expect(cta?.getAttribute("href")).toBe("/login")
  })
})
