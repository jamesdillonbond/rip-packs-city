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
})
