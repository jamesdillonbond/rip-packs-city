// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// GlobalSiteHeader — measured at 0% statements before this file, on the one
// component that mounts on every page outside the (collections) group.
//
// It is pure composition, and that is exactly the risk: a refactor that drops
// one child from this file removes it from EVERY page at once, with `tsc`
// green and no other test noticing. The repo has already paid for the
// neighbouring version of this — the (since-deleted, 2026-09-25) ProBadge
// would have gone dark site-wide from here.
//
// The children are stubbed because each is separately tested and several fetch
// on mount; what is pinned here is the CONTRACT — which children the header
// mounts, and the home link — not their internals.

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
    // dropped: sign-in state (sign-out), catalog discovery
    // (global-search), collection navigation (top-nav), theme (theme-toggle).
    for (const slot of [
      "logo",
      "top-nav",
      "global-search",
      "theme-toggle",
      "sign-out",
    ]) {
      expect(
        container.querySelector(`[data-slot="${slot}"]`),
        `GlobalSiteHeader must mount ${slot} — dropping it removes the capability from every page`,
      ).not.toBeNull()
    }
  })

  // 2026-09-25 (Trevor): no paid account is mentioned anywhere on the site
  // until 100 weekly active users. The PRO / FOUNDING badge was the header's
  // paid-tier surface, so its ABSENCE is the contract now.
  it("does not mount a Pro badge", () => {
    // The component no longer exists; pin that the header cannot import one.
    const src = readFileSync(join(process.cwd(), "components/GlobalSiteHeader.tsx"), "utf8")
    expect(src).not.toMatch(/ProBadge/)
    const { container } = render(<GlobalSiteHeader />)
    expect(container.textContent ?? "").not.toMatch(/\bpro\b|founding/i)
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

  it("fits a phone: the handle hides and the gaps tighten under 480 px (2026-09-25)", () => {
    // Measured at 390 px by the true-mobile sweep: the row overflowed its
    // overflow:hidden box and the SIGN IN button rendered as "SIGN". jsdom has
    // no layout, so the pinned facts are the CSS that produces the fit: the
    // rule exists, targets both hooks, and both hooks are on the elements.
    const { container } = render(<GlobalSiteHeader />)
    const css = Array.from(container.querySelectorAll("style")).map((s) => s.textContent ?? "").join("\n")
    expect(css).toMatch(/@media \(max-width: 480px\)/)
    expect(css).toMatch(/\.rpc-gsh-label \{ display: none !important; \}/)
    expect(css).toMatch(/\.rpc-gsh-row \{ gap: 8px !important; padding: 0 12px !important; \}/)
    expect(container.querySelector(".rpc-gsh-row")).not.toBeNull()
    const label = container.querySelector(".rpc-gsh-label")
    expect(label?.textContent).toBe("@RIPPACKSCITY")
  })
})
