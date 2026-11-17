// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import HomePageMarketing from "@/components/HomePageMarketing"
import { visibleGroups } from "@/lib/ia"
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
vi.mock("@/components/search/GlobalSearch", () => ({ default: () => <div data-testid="global-search" /> }))

beforeEach(() => { funnelMock.mockClear() })
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
    // 2026-11-06: no SearchAction — its /share/{term} target was a wallet-card route
    // robots disallows, not a search; the feature is retired upstream too.
    expect(ld!.textContent).not.toContain("SearchAction")
    expect(ld!.textContent).not.toContain("/share/")

    // The h1 is the SEARCHED QUESTION, not the brand name (changed 2026-08-01).
    // This assertion previously pinned "Rip Packs", which is why it caught the
    // swap — keep it pinned to the *intent* (the value question) rather than to
    // exact marketing copy, so a wording tweak doesn't red CI but a silent
    // regression back to a brand-name h1 does.
    const h1 = getByRole("heading", { level: 1 }).textContent ?? ""
    expect(h1.toLowerCase()).toContain("worth")
    expect(h1.toLowerCase()).not.toContain("rip packs")
  })

  // 2026-11-07: the landing header was a FOURTH nav vocabulary (Insights ·
  // Collections · How it works · Free account). IA rule 4: every nav shows the
  // same groups in the same order — so it renders the registry's public groups,
  // in registry order, and nothing hand-written beside them but Sign In.
  // 2026-11-07 (Trevor): a new visitor had no door — the header said only SIGN IN.
  // Now the registry's groups, then "Sign in", then the primary CREATE FREE ACCOUNT
  // pill, which lands on /login?intent=signup (same magic-link form, headed as
  // account creation).
  it("the header nav is the registry's public groups, in order, then Sign in + Create free account", () => {
    const { container } = render(<HomePageMarketing />)
    const nav = container.querySelector("nav.rpc-home-nav") as HTMLElement
    const links = Array.from(nav.querySelectorAll("a"))
    const labels = links.map((a) => a.textContent?.trim())
    const expected = visibleGroups(false).map((g) => g.label)
    expect(labels).toEqual([...expected, "Sign in", "Create free account"])
    expect(links[links.length - 1].getAttribute("href")).toBe("/login?intent=signup")
    expect(links[links.length - 2].getAttribute("href")).toBe("/login")
    expect(nav.querySelector('a[href^="#"]')).toBeNull()
  })

  it("the hero carries a Create free account door under the search box", () => {
    const { container } = render(<HomePageMarketing />)
    const hero = container.querySelector("section.rpc-home-hero") as HTMLElement
    const cta = Array.from(hero.querySelectorAll("a")).find((a) => /create free account/i.test(a.textContent ?? ""))
    expect(cta?.getAttribute("href")).toBe("/login?intent=signup")
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

describe("landmarks (axe landmark-one-main / region, 2026-10-12)", () => {
  afterEach(cleanup)
  it("renders exactly one <main> and every content section sits inside it", () => {
    const { container } = render(<HomePageMarketing />)
    const mains = container.querySelectorAll("main")
    expect(mains).toHaveLength(1)
    const sections = Array.from(container.querySelectorAll("section"))
    expect(sections.length).toBeGreaterThan(5)
    const outside = sections.filter((s) => !mains[0].contains(s))
    expect(outside.map((s) => s.className)).toEqual([])
    // The header is NOT inside main — it stays its own landmark.
    const header = container.querySelector("header")
    expect(header).not.toBeNull()
    expect(mains[0].contains(header!)).toBe(false)
  })
})

// IA Phase 3 (2026-11-06): the homepage pitches pillars, not features — one
// door per public job group from lib/ia.ts, and the single-feature pitch
// sections it replaced are gone.
describe("HomePageMarketing — the five doors", () => {
  it("renders one door per anonymous group, each linking its hub and up to four public items", async () => {
    const { visibleGroups, visibleItems, resolveHref, DEFAULT_COLLECTION } = await import("@/lib/ia")
    const { container } = render(<HomePageMarketing />)
    const groups = visibleGroups(false)
    expect(groups.map((g) => g.id)).toEqual(["market", "packs", "insights", "collectors", "trade"])
    for (const g of groups) {
      const door = container.querySelector(`[data-home-door="${g.id}"]`)!
      expect(door, g.id).toBeTruthy()
      const links = Array.from(door.querySelectorAll("a")).map((a) => a.getAttribute("href"))
      expect(links[0], g.id).toBe(resolveHref(g.href, DEFAULT_COLLECTION, g.page))
      expect(links.slice(1), g.id).toEqual(visibleItems(g, false).slice(0, 4).map((i) => resolveHref(i.href, DEFAULT_COLLECTION, i.page)))
    }
    // No signed-in-only destination on the anonymous homepage.
    const all = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    for (const gated of ["/trades", "/dashboard/packs", "/my-teams", "/alerts"]) expect(all).not.toContain(gated)
  })

  it("the single-feature pitch sections are gone (their features live inside a door)", () => {
    const { container } = render(<HomePageMarketing />)
    const text = container.textContent ?? ""
    expect(text).not.toMatch(/THINGS TOP SHOT WON.T TELL YOU/i)
    expect(text).not.toMatch(/FAST BREAK LINEUP OPTIMIZER/i)
    expect(text).not.toMatch(/FIND YOUR EDGE\./i)
    // What stays: the proof — stats band, collections, pricing you can check, a real trophy case, how it works, signup.
    expect(text).toMatch(/A PRICE YOU CAN CHECK/i)
    expect(container.querySelector("[data-home-trophy-case]")).toBeTruthy()
    expect(text).toMatch(/FREE\. NO INVITE NEEDED\./i)
  })
})
