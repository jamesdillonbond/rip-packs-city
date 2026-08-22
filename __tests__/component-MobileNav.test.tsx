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

import MobileNav from "@/components/MobileNav"

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
