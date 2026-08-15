// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// GlobalSiteHeader — measured at 0% statements before this file, on the one
// component that mounts on every page outside the (collections) group.
//
// It is pure composition, and that is exactly the risk: a refactor that drops
// one child from this file removes it from EVERY page at once, with `tsc`
// green and no other test noticing. The repo has already paid for the
// neighbouring version of this — ProBadge would have gone dark site-wide from
// here (see component-ProBadge.test.tsx).
//
// The children are stubbed because each is separately tested and several fetch
// on mount; what is pinned here is the CONTRACT — which children the header
// mounts, and the home link — not their internals.

vi.mock("@/components/auth/ProBadge", () => ({ ProBadge: () => <i data-slot="pro-badge" /> }))
vi.mock("@/components/auth/SignOutButton", () => ({ default: () => <i data-slot="sign-out" /> }))
vi.mock("@/components/RpcLogo", () => ({ default: () => <i data-slot="logo" /> }))
vi.mock("@/components/TopNav", () => ({ default: () => <i data-slot="top-nav" /> }))
vi.mock("@/components/ThemeToggle", () => ({ default: () => <i data-slot="theme-toggle" /> }))
vi.mock("@/components/search/GlobalSearch", () => ({ default: () => <i data-slot="global-search" /> }))

import GlobalSiteHeader from "@/components/GlobalSiteHeader"

afterEach(cleanup)

describe("GlobalSiteHeader — the site-wide nav contract", () => {
  it("mounts every child the header is responsible for", () => {
    const { container } = render(<GlobalSiteHeader />)
    // Each entry here is a capability that vanishes site-wide if the child is
    // dropped: sign-in state (pro-badge / sign-out), catalog discovery
    // (global-search), collection navigation (top-nav), theme (theme-toggle).
    for (const slot of [
      "logo",
      "top-nav",
      "global-search",
      "theme-toggle",
      "pro-badge",
      "sign-out",
    ]) {
      expect(
        container.querySelector(`[data-slot="${slot}"]`),
        `GlobalSiteHeader must mount ${slot} — dropping it removes the capability from every page`,
      ).not.toBeNull()
    }
  })

  it("keeps a working route home", () => {
    // The reason this component exists: top-level routes outside the
    // (collections) group were orphaned with no way back into the site.
    const { container } = render(<GlobalSiteHeader />)
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).toContain("/")
  })

  it("renders a sticky <header> landmark", () => {
    // A <div> here would drop the banner landmark for every page on the site,
    // and losing `position: sticky` silently changes navigation on every scroll.
    const { container } = render(<GlobalSiteHeader />)
    const header = container.querySelector("header")
    expect(header).not.toBeNull()
    expect(header!.style.position).toBe("sticky")
  })
})
