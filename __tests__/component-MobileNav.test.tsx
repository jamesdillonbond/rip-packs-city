// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

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
  // ⭐ RE-SLOTTED 2026-09-12: HOME · SEARCH · SNIPER · MY STUFF · COLLECTIONS.
  // Was PROFILE · SNIPER · PACKS · WALLET · COLLECTIONS — four of five slots on
  // one collection's sub-pages, no way back to the homepage, no entry to search
  // at all, and the centre (best thumb position) spent on Packs.
  it("renders the re-slotted bottom tab bar", () => {
    const { getByText, container } = render(<MobileNav />)
    expect(container.querySelector("nav.rpc-mobile-nav")).toBeTruthy()
    for (const label of ["HOME", "SEARCH", "SNIPER", "MY STUFF", "COLLECTIONS"]) {
      expect(getByText(label), label).toBeTruthy()
    }
  })

  // ⛔ THE ONE HREF THAT MUST NOT DRIFT. /dashboard is auth-gated, and this is the
  // tab a first-run visitor scans first: the measured chain used to be
  // `/profile → 308 → /dashboard → 307 → /login?next=…`, two hops into a login
  // wall from the first tap. app/profile/page.tsx exists specifically to end that
  // (register R36) — it is PUBLIC (proxy.ts allows it explicitly) and
  // server-redirects a signed-in visitor onward. Re-pointing MY STUFF at
  // /dashboard silently reinstates the wall, and nothing else would catch it.
  it("⛔ MY STUFF points at the PUBLIC /profile, never at auth-gated /dashboard", () => {
    const { container } = render(<MobileNav />)
    const bar = container.querySelector("nav.rpc-mobile-nav") as HTMLElement
    const links = Array.from(bar.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).toContain("/profile")
    expect(links).not.toContain("/dashboard")
  })

  it("gives the bar a way home, which it did not have", () => {
    const { container } = render(<MobileNav />)
    const bar = container.querySelector("nav.rpc-mobile-nav") as HTMLElement
    expect(Array.from(bar.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toContain("/")
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
    // After the 2026-09-12 re-slot only ONE tab is collection-scoped (Sniper);
    // Home, Search, My Stuff and Collections are not, so a thin collection can
    // only ever render one inert tab.
    const inert = Array.from(bar.querySelectorAll("[aria-disabled='true']"))
    expect(inert.length).toBe(1)
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
  it("lights Sniper on the sniper page, and hands every other collection page to the sheet", () => {
    expect(activeTabFor("/nba-top-shot/sniper", "sniper", true)).toBe("sniper")
    // Packs and Wallet left the bar in the re-slot; the Collections sheet is how
    // you move between a collection's pages, so it owns them.
    expect(activeTabFor("/nba-top-shot/packs", "packs", true)).toBe("collections")
    expect(activeTabFor("/nba-top-shot/collection", "collection", true)).toBe("collections")
  })

  it("⚠ lights a tab on a collection's own /overview — the gap the re-slot closed", () => {
    // Overview is the most common entry point in the product and was never one
    // of the five tabs, so before 2026-09-12 it lit nothing at all. Confirmed
    // live that day: five identical glyphs, none active.
    expect(activeTabFor("/nba-top-shot/overview", "overview", true)).toBe("collections")
  })

  it("lights Home on the homepage", () => {
    expect(activeTabFor("/", "", false)).toBe("home")
  })

  it("⚠ does NOT light a collection tab on /dashboard/packs — that tab links elsewhere", () => {
    // `segments[1]` is "packs" here, and the old rule lit the Packs tab, whose
    // href is /{collection}/packs — the market page. Tapping the active tab left.
    expect(activeTabFor("/dashboard/packs", "packs", false)).toBe("mystuff")
  })

  it("⚠ lights My Stuff on every account surface, not just /profile", () => {
    for (const p of ["/profile", "/profile/someone", "/dashboard", "/dashboard/history", "/alerts", "/rewards", "/my-teams"]) {
      expect(activeTabFor(p, "", false), p).toBe("mystuff")
    }
  })

  it("does not claim a tab for a route none of them own", () => {
    // /insights/* genuinely belongs to no tab — it is cross-collection. Returning
    // null is the honest answer; the bug was that every COLLECTION page did too.
    expect(activeTabFor("/insights/candy-mlb", "candy-mlb", false)).toBeNull()
    expect(activeTabFor("/blog", "", false)).toBeNull()
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

// ─────────────────────────────────────────────────────────────────────────────
// WHERE the bar is mounted — ONE PLACE, as of 2026-09-12
//
// It used to be mounted AD HOC in ELEVEN files, and two whole route families
// fell through the gaps. Measured that day:
//   * /dashboard/packs (the surface Trevor screenshotted), /dashboard/history,
//     /dashboard/alerts and /dashboard/notifications: `app/dashboard/layout.tsx`
//     was `return children`, and only two of the six routes under it carried the
//     bar themselves.
//   * every one of the ~30 boards under /insights, including /insights/candy-mlb
//     — the ONLY Candy surface that exists, since the collection is pinned to
//     pages:["overview"]. On a phone the largest anonymous surface in the product
//     was a dead end.
//
// ⭐ The fix is not "mount it in two more layouts" — that is what the previous
// pass did, and it leaves the same shape that produced the gap. The bar now
// mounts ONCE, in `app/layout.tsx`, and the eleven ad-hoc sites are gone.
//
// Pinned as a SOURCE fact because there is no route-level render harness here
// and the failure is silent BOTH WAYS: a layout that stops mounting the bar
// looks fine in every component test, and so does a file that mounts a SECOND
// one — two `position: fixed; bottom: 0` bars stack exactly on top of each other
// and read as one bar with doubled tap targets. So this counts the whole tree
// rather than naming the eleven files it replaced: naming them would pass
// happily the day someone adds a twelfth.
describe("MobileNav — the single mount", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(join(process.cwd(), dir))) {
      if (name === "node_modules" || name.startsWith(".")) continue
      const rel = `${dir}/${name}`
      if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out)
      else if (/\.(tsx|jsx)$/.test(name)) out.push(rel)
    }
    return out
  }

  it("is mounted by the ROOT layout", () => {
    expect(read("app/layout.tsx")).toContain("<MobileNav />")
  })

  it("⚠ is mounted in EXACTLY ONE file across app/ and components/", () => {
    const mounts = [...walk("app"), ...walk("components")].filter((p) => /<MobileNav\b/.test(read(p)))
    expect(mounts).toEqual(["app/layout.tsx"])
  })

  it("⚠ none of the eleven former ad-hoc sites mounts it any more", () => {
    const FORMER = [
      "app/(analytics)/analytics/layout.tsx",
      "app/(collections)/layout.tsx",
      "app/alerts/AlertsClient.tsx",
      "app/dashboard/layout.tsx",
      "app/dashboard/DashboardClient.tsx",
      "app/dashboard/api-keys/ApiKeysClient.tsx",
      "app/insights/layout.tsx",
      "app/my-teams/layout.tsx",
      "app/pinnacle/moment/[id]/page.tsx",
      "app/rewards/page.tsx",
      "app/special-serial-owners/SpecialSerialOwnersClient.tsx",
      "components/HomePageMarketing.tsx",
    ]
    for (const p of FORMER) expect(read(p), p).not.toContain("<MobileNav")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The Search sheet (2026-09-12)
//
// The bar had NO entry to search at all. `GlobalSearch` is the header's search
// box — already wired to /api/search with its own keyboard handling — and on a
// phone the header is collapsed, so there was no way to reach it. Reused rather
// than reimplemented, inside the same sheet pattern (Escape, focus trap, focus
// restore) the Collections sheet already uses.
describe("MobileNav — the Search sheet", () => {
  // ⚠ Queried through the DOM, not `getByRole`: the sheets carry
  // `.rpc-mobile-sheet { display: none !important }` outside the mobile media
  // query, jsdom applies it, and a display:none node is absent from the a11y
  // tree — so `queryByRole("dialog")` never matches here. The file's existing
  // sheet tests already do it this way.
  const dialogNamed = (c: HTMLElement, name: string) =>
    Array.from(c.querySelectorAll('[role="dialog"]')).find((d) => d.getAttribute("aria-label") === name) ?? null

  it("opens a labelled modal from the Search tab and closes it again", () => {
    const { getByText, getByLabelText, container } = render(<MobileNav />)
    expect(dialogNamed(container, "Search")).toBeNull()
    fireEvent.click(getByText("SEARCH").closest("button")!)
    expect(dialogNamed(container, "Search")).toBeTruthy()
    fireEvent.click(getByLabelText("Close search"))
    expect(dialogNamed(container, "Search")).toBeNull()
  })

  it("puts the real search input in it, not a placeholder", () => {
    const { getByText, getByLabelText } = render(<MobileNav />)
    fireEvent.click(getByText("SEARCH").closest("button")!)
    // GlobalSearch's own input, by its own aria-label.
    expect(getByLabelText("Search the catalog")).toBeTruthy()
  })

  it("⚠ the two sheets are mutually exclusive — one bar, one surface at a time", () => {
    const { getByText, container } = render(<MobileNav />)
    fireEvent.click(getByText("COLLECTIONS").closest("button")!)
    expect(dialogNamed(container, "Collections")).toBeTruthy()
    fireEvent.click(getByText("SEARCH").closest("button")!)
    expect(dialogNamed(container, "Search")).toBeTruthy()
    expect(dialogNamed(container, "Collections")).toBeNull()
    fireEvent.click(getByText("COLLECTIONS").closest("button")!)
    expect(dialogNamed(container, "Collections")).toBeTruthy()
    expect(dialogNamed(container, "Search")).toBeNull()
  })

  it("closes on Escape like the Collections sheet", () => {
    const { getByText, container } = render(<MobileNav />)
    fireEvent.click(getByText("SEARCH").closest("button")!)
    expect(dialogNamed(container, "Search")).toBeTruthy()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(dialogNamed(container, "Search")).toBeNull()
  })
})
