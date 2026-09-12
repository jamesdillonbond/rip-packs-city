// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// MobileNav (0% before this) is the bottom mobile tab bar + the slide-up
// Collections sheet. Drives its OWN code: the pathname->active-tab derivation,
// the tab render (link tabs + the Collections button tab), and the sheet
// open/close state machine (role=dialog "Collections").

const nav = { pathname: "/nba-top-shot/collection", push: vi.fn() }
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push, replace: vi.fn(), prefetch: vi.fn() }),
}))

import MobileNav, { activeTabFor } from "@/components/MobileNav"

afterEach(() => {
  cleanup()
  nav.push.mockClear()
})

describe("MobileNav", () => {
  it("renders the bottom tab bar with the wallet + collections tabs", () => {
    const { getByText, container } = render(<MobileNav />)
    expect(container.querySelector("nav.rpc-mobile-nav")).toBeTruthy()
    expect(getByText("WALLET")).toBeTruthy()
    expect(getByText("COLLECTIONS")).toBeTruthy()
  })

  // ⚠ MEASURED, then pinned. In Chromium at 390x844 the five tabs were
  // 37x32 / 32x32 / **26x32** / 32x32 / 58x32 — under the 44px floor (§9,
  // WCAG 2.5.5) in BOTH axes, on the product's most-tapped control set, inside
  // a bar that was already 60px tall. jsdom cannot measure a box, so what is
  // pinned here is the three style facts that PRODUCE the 44px: the bar is
  // tall enough, each tab stretches to it, and each tab is at least 44 wide.
  // Drop any one and the target silently shrinks back with every test green.
  it("gives every bottom tab a >=44px tap target in both axes", () => {
    const { container } = render(<MobileNav />)
    const bar = container.querySelector("nav.rpc-mobile-nav") as HTMLElement
    // 1. Stretching is only worth anything if the bar clears the floor itself.
    expect(parseInt(bar.style.height, 10)).toBeGreaterThanOrEqual(44)

    const tabs = Array.from(bar.children).filter(
      (c) => c.tagName === "A" || c.tagName === "BUTTON",
    ) as HTMLElement[]
    expect(tabs.length).toBe(5)

    for (const tab of tabs) {
      const label = (tab.textContent ?? "").trim()
      // 2. Fills the bar's height — NOT a hardcoded px, so this stays true if
      //    NAV_HEIGHT moves.
      expect(`${label}:${tab.style.alignSelf}`).toBe(`${label}:stretch`)
      // 3. Clears the floor horizontally. The narrowest ("PACKS") measured 26px.
      expect(`${label}:${parseInt(tab.style.minWidth, 10) >= 44}`).toBe(`${label}:true`)
      // Assert the ABSENCE of the zero padding that caused this: a tab hugging
      // its 8px caption is the defect, whatever the rest of the style says.
      expect(`${label}:${tab.style.padding}`).not.toBe(`${label}:0px`)
    }
  })

  it("opens the Collections sheet from the collections tab and closes it", () => {
    const { getByText, getByLabelText, container } = render(<MobileNav />)
    // Sheet is closed initially.
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    fireEvent.click(getByText("COLLECTIONS").closest("button")!)
    // Sheet (role=dialog aria-label="Collections") is now open.
    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).toBeTruthy()
    expect(dialog?.getAttribute("aria-label")).toBe("Collections")
    fireEvent.click(getByLabelText("Close collections"))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  // Modal a11y wired via useModalA11y (previously the sheet had a backdrop/×
  // close but no keyboard or focus handling).
  it("closes the Collections sheet on Escape", () => {
    const { getByText, container } = render(<MobileNav />)
    fireEvent.click(getByText("COLLECTIONS").closest("button")!)
    expect(container.querySelector('[role="dialog"]')).toBeTruthy()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it("moves focus into the sheet when opened and marks it aria-modal", () => {
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0)
        return 1
      })
    const cafSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
    const { getByText, container } = render(<MobileNav />)
    fireEvent.click(getByText("COLLECTIONS").closest("button")!)
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute("aria-modal")).toBe("true")
    expect(dialog.contains(document.activeElement)).toBe(true)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })
})

describe("MobileNav — thin collections (2026-09-06)", () => {
  it("renders the tabs a thin collection lacks as INERT, never as links to a page that does not exist", () => {
    nav.pathname = "/candy-mlb/overview"
    const { container } = render(<MobileNav />)
    const bar = container.querySelector("nav.rpc-mobile-nav") as HTMLElement
    const links = Array.from(bar.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).toContain("/profile")
    for (const dead of ["/candy-mlb/sniper", "/candy-mlb/packs", "/candy-mlb/collection"]) {
      expect(links, dead).not.toContain(dead)
    }
    const inert = Array.from(bar.querySelectorAll("[aria-disabled='true']"))
    expect(inert.length).toBe(3)
    nav.pathname = "/nba-top-shot/collection"
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The active-tab map (2026-09-12)
//
// ⚠ TWO MEASURED DEFECTS, both from deriving "active" by string coincidence
// (`segments[1] === key`, plus `startsWith("/profile")` for one tab):
//
//   (a) NO TAB WAS ACTIVE ON MOST OF THE APP — not on /dashboard, not on
//       /dashboard/packs, not on a collection's own /overview landing tab, not
//       on /alerts, /rewards, /my-teams, /insights/* or /. Confirmed live on
//       /nba-top-shot/overview: five identical glyphs, none active, on the most
//       common entry point in the product.
//   (b) ON /dashboard/packs THE PACKS TAB LIT UP POINTING SOMEWHERE ELSE —
//       `segments[1]` is "packs" there, while the tab's href is
//       /{collection}/packs, the market page. Tapping the active tab left it.
//
// These drive `activeTabFor` directly so the map is pinned independently of how
// the bar happens to render it.
describe("MobileNav — which tab owns the route", () => {
  it("lights the collection tab the page actually lives on", () => {
    expect(activeTabFor("/nba-top-shot/sniper", "sniper", true)).toBe("sniper")
    expect(activeTabFor("/nba-top-shot/packs", "packs", true)).toBe("packs")
    expect(activeTabFor("/nba-top-shot/collection", "collection", true)).toBe("wallet")
  })

  it("⚠ does NOT light the Packs tab on /dashboard/packs — that tab links elsewhere", () => {
    // The account surface owns this route; Packs would send the reader away.
    expect(activeTabFor("/dashboard/packs", "packs", false)).toBe("profile")
    expect(activeTabFor("/dashboard/packs", "packs", false)).not.toBe("packs")
  })

  it("⚠ lights Profile on every account surface, not just /profile", () => {
    for (const p of ["/profile", "/profile/someone", "/dashboard", "/dashboard/history", "/alerts", "/rewards", "/my-teams"]) {
      expect(activeTabFor(p, "", false), p).toBe("profile")
    }
  })

  it("does not claim a tab for a route none of them own", () => {
    // /insights/* and / genuinely belong to no tab. Returning null is the honest
    // answer; the bug was that EVERY collection page also returned null.
    expect(activeTabFor("/insights/candy-mlb", "candy-mlb", false)).toBeNull()
    expect(activeTabFor("/", "", false)).toBeNull()
    expect(activeTabFor("/nba-top-shot/overview", "overview", true)).toBeNull()
  })

  it("⚠ a prefix match must not swallow an unrelated route", () => {
    // "/profiles-of-note" starts with "/profile" as a STRING but is not under it.
    expect(activeTabFor("/profiles-of-note", "", false)).toBeNull()
  })

  it("renders the active tab in the brand red and the rest at the readable token", () => {
    // ⚠ MEASURED: `--rpc-text-ghost` is rgba(255,255,255,0.2) = **1.80 : 1**
    // against the nav's own #0d0d0d, on 8px labels. WCAG AA wants 4.5:1.
    // `--rpc-text-secondary` measures 6.25 : 1 on the same ground, and it is
    // theme-aware so it holds in light mode. Assert the ABSENCE of the
    // unreadable token, which is the thing that was wrong.
    nav.pathname = "/nba-top-shot/collection"
    const { container } = render(<MobileNav />)
    const bar = container.querySelector("nav.rpc-mobile-nav") as HTMLElement
    const html = bar.innerHTML
    expect(html).not.toContain("--rpc-text-ghost")
    expect(html).toContain("--rpc-text-secondary")
    expect(html).toContain("--rpc-red")
  })

  it("pads the BAR itself for the home indicator, not just the body", () => {
    // The body already reserved `60px + env(safe-area-inset-bottom)`; the bar did
    // not, so its content was centred inside a box whose lower strip is the
    // indicator. content-box keeps the 60px content height and puts the inset
    // below it, so nothing moves on a device without one.
    const { container } = render(<MobileNav />)
    // ⚠ Asserted on the component's own stylesheet, not on `bar.style`: jsdom's
    // CSS parser DROPS an inline `env(...)` value, so the inline form reads as
    // absent here and the test would pin nothing.
    const css = container.querySelector("nav.rpc-mobile-nav style")?.textContent ?? ""
    expect(css).toContain("padding-bottom: env(safe-area-inset-bottom")
    expect(css).toContain("box-sizing: content-box")
  })
})
