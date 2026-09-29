// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// MobileNav is the bottom mobile tab bar. Drives its OWN code: the
// pathname->active-tab derivation, the collection resolution behind the Market
// and Sniper hrefs, and the inert-tab rule for a collection lacking a page.

const nav = { pathname: "/nba-top-shot/collection" }
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}))

import MobileNav, { activeTabFor } from "@/components/MobileNav"

afterEach(() => {
  cleanup()
  nav.pathname = "/nba-top-shot/collection"
})

const bar = (c: HTMLElement) => c.querySelector("nav.rpc-mobile-nav") as HTMLElement
const hrefs = (c: HTMLElement) => Array.from(bar(c).querySelectorAll("a")).map((a) => a.getAttribute("href"))
const tab = (c: HTMLElement, label: string) =>
  Array.from(bar(c).querySelectorAll("a, span[aria-disabled]")).find(
    (e) => (e.textContent ?? "").trim() === label,
  ) as HTMLElement

describe("MobileNav", () => {
  // ⭐ RE-SLOTTED 2026-09-28 (Trevor): HOME · MY BINDER · MARKET · SNIPER.
  // Was HOME · SEARCH · SNIPER · MY STUFF · COLLECTIONS — two of the five were
  // sheets duplicating chrome the page already carries (the header's search box,
  // the collection switcher + tab bar).
  it("renders the four tabs, in order", () => {
    const { container } = render(<MobileNav />)
    const labels = Array.from(bar(container).children)
      .filter((c) => c.tagName === "A" || c.tagName === "SPAN")
      .map((c) => (c.textContent ?? "").trim())
    expect(labels).toEqual(["HOME", "MY BINDER", "MARKET", "SNIPER"])
  })

  it("renders no sheet or dialog — every tab is a destination", () => {
    const { container } = render(<MobileNav />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(bar(container).querySelector("button")).toBeNull()
  })

  // ⭐ RE-PINNED 2026-09-28 (Trevor): My Binder is the WALLET page — one
  // wallet's holdings — not the account dashboard. It carries no `?wallet=`: the
  // page re-opens this device's last lookup itself. ⛔ Never auth-gated
  // /dashboard: a login wall from the first tap (register R36).
  it("⛔ MY BINDER opens the collection's binder page, never auth-gated /dashboard", () => {
    const { container } = render(<MobileNav />)
    expect(tab(container, "MY BINDER").getAttribute("href")).toBe("/nba-top-shot/collection")
    expect(hrefs(container)).not.toContain("/dashboard")
    expect(hrefs(container).some((h) => h?.includes("wallet="))).toBe(false)
  })

  it("scopes My Binder and Market to the collection in the URL", () => {
    nav.pathname = "/nfl-all-day/overview"
    const { container } = render(<MobileNav />)
    expect(tab(container, "MY BINDER").getAttribute("href")).toBe("/nfl-all-day/collection")
    expect(tab(container, "MARKET").getAttribute("href")).toBe("/nfl-all-day/market")
  })

  // ⭐ 2026-09-28: SNIPER opens the cross-collection HUB, the same place from
  // every page — not a collection the visitor never chose.
  it("SNIPER opens the /sniper hub from every page", () => {
    for (const p of ["/", "/nfl-all-day/overview", "/ufc/overview", "/insights/deals"]) {
      nav.pathname = p
      const { container } = render(<MobileNav />)
      expect(tab(container, "SNIPER").getAttribute("href"), p).toBe("/sniper")
      cleanup()
    }
  })

  it("on a Disney Pinnacle pin page (/pinnacle/moment/<id>) Market goes to Pinnacle's market", () => {
    nav.pathname = "/pinnacle/moment/OEEV1-EXPD-MINN-E2"
    const { container } = render(<MobileNav />)
    expect(hrefs(container)).toContain("/disney-pinnacle/market")
    expect(hrefs(container)).not.toContain("/nba-top-shot/market")
  })

  it("gives the bar a way home", () => {
    const { container } = render(<MobileNav />)
    expect(hrefs(container)).toContain("/")
  })

  // An emoji ignores `color`, so with the old 🏠 🔍 ⚡ 👤 🗂 set the active
  // state reached only the caption. The glyph must follow currentColor.
  it("draws every icon as a currentColor SVG, never an emoji", () => {
    const { container } = render(<MobileNav />)
    const tabs = Array.from(bar(container).children).filter((c) => c.tagName !== "STYLE")
    expect(tabs.length).toBe(4)
    for (const t of tabs) {
      const svg = t.querySelector("svg")
      expect(svg, t.textContent ?? "").not.toBeNull()
      expect(svg!.getAttribute("stroke")).toBe("currentColor")
      expect(t.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })

  // ⚠ MEASURED 2026-08-22 at 390x844: tabs as small as 26x32, under the 44px
  // floor in BOTH axes. jsdom cannot measure a box, so what is pinned is the
  // three style facts that PRODUCE the 44px.
  it("gives every bottom tab a >=44px tap target in both axes", () => {
    const { container } = render(<MobileNav />)
    expect(parseInt(bar(container).style.height, 10)).toBeGreaterThanOrEqual(44)
    const tabs = Array.from(bar(container).children).filter((c) => c.tagName !== "STYLE") as HTMLElement[]
    expect(tabs.length).toBe(4)
    for (const t of tabs) {
      const label = (t.textContent ?? "").trim()
      expect(`${label}:${t.style.alignSelf}`).toBe(`${label}:stretch`)
      expect(`${label}:${parseInt(t.style.minWidth, 10) >= 44}`).toBe(`${label}:true`)
      expect(`${label}:${t.style.padding}`).not.toBe(`${label}:0px`)
    }
  })
})

describe("MobileNav — thin collections", () => {
  it("renders the tabs a collection lacks as INERT, never as links to a page that does not exist", () => {
    // UFC has no market page. (Its missing sniper no longer matters: SNIPER is
    // the cross-collection hub.)
    nav.pathname = "/ufc/overview"
    const { container } = render(<MobileNav />)
    expect(hrefs(container)).not.toContain("/ufc/market")
    // ⛔ and never SUBSTITUTES another collection's page for the missing one.
    expect(hrefs(container).filter((h) => h?.endsWith("/market"))).toEqual([])
    const inert = Array.from(bar(container).querySelectorAll("[aria-disabled='true']"))
    expect(inert.map((e) => (e.textContent ?? "").trim())).toEqual(["MARKET"])
    expect(hrefs(container)).toContain("/sniper")
    expect(hrefs(container)).toContain("/ufc/collection")
  })

  it("a collection with a market but no sniper of its own has NO inert tab", () => {
    // Candy MLB: before the hub, its SNIPER tab was inert.
    nav.pathname = "/candy-mlb/overview"
    const { container } = render(<MobileNav />)
    expect(hrefs(container)).toContain("/candy-mlb/market")
    expect(hrefs(container)).toContain("/sniper")
    expect(hrefs(container)).not.toContain("/candy-mlb/sniper")
    expect(bar(container).querySelectorAll("[aria-disabled='true']").length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The active-tab map
//
// ⚠ Pre-2026-09-12 "active" was derived by string coincidence (`segments[1] ===
// key`): no tab lit on most of the app, and on /dashboard/packs a Packs tab lit
// whose href was the MARKET page — tapping the active tab left. The map is by
// DESTINATION: a route lights the tab whose href lands there, or none.
describe("MobileNav — which tab owns the route", () => {
  it("lights Home on the homepage", () => {
    expect(activeTabFor("/", "", false)).toBe("home")
  })

  it("lights Sniper on the hub itself", () => {
    expect(activeTabFor("/sniper", "", false)).toBe("sniper")
  })

  it("lights Sniper on the sniper pages, including Pack Sniper behind its sub-toggle", () => {
    expect(activeTabFor("/nba-top-shot/sniper", "sniper", true)).toBe("sniper")
    expect(activeTabFor("/nba-top-shot/pack-sniper", "pack-sniper", true)).toBe("sniper")
  })

  it("lights Market on the market and the pages folded into it", () => {
    for (const p of ["market", "packs", "hot-floors"]) {
      expect(activeTabFor(`/nba-top-shot/${p}`, p, true), p).toBe("market")
    }
  })

  it("lights My Binder on a collection's binder page", () => {
    expect(activeTabFor("/nba-top-shot/collection", "collection", true)).toBe("binder")
    expect(activeTabFor("/candy-mlb/collection", "collection", true)).toBe("binder")
  })

  it("lights nothing on a collection page no tab leads to", () => {
    // Overview, Sets, Analytics are reached through the collection's own
    // switcher + tab bar. No bottom tab goes there, so none may claim to.
    for (const p of ["overview", "sets", "analytics"]) {
      expect(activeTabFor(`/nba-top-shot/${p}`, p, true), p).toBeNull()
    }
  })

  it("⚠ does NOT light a collection tab on /dashboard/packs — that tab links elsewhere", () => {
    // `segments[1]` is "packs" here; Market's href is /{collection}/market.
    expect(activeTabFor("/dashboard/packs", "packs", false)).toBeNull()
  })

  it("lights no tab on the account surfaces — no tab leads to them any more", () => {
    // My Binder is the wallet page (2026-09-28). The dashboard is reached through
    // the header's sign-in pill, so lighting My Binder there would point away.
    for (const p of ["/profile", "/profile/someone", "/dashboard", "/dashboard/history", "/alerts", "/my-teams"]) {
      expect(activeTabFor(p, "", false), p).toBeNull()
    }
  })

  it("does not claim a tab for a route none of them own", () => {
    expect(activeTabFor("/insights/candy-mlb", "candy-mlb", false)).toBeNull()
    expect(activeTabFor("/blog", "", false)).toBeNull()
  })

  it("⚠ a prefix match must not swallow an unrelated route", () => {
    expect(activeTabFor("/profiles-of-note", "", false)).toBeNull()
  })

  it("renders the active tab in the brand red and the rest at the readable token", () => {
    // ⚠ `--rpc-text-ghost` measures 1.80 : 1 on the nav's own #0d0d0d.
    nav.pathname = "/nba-top-shot/market"
    const { container } = render(<MobileNav />)
    const html = bar(container).innerHTML
    expect(html).not.toContain("--rpc-text-ghost")
    expect(tab(container, "MARKET").style.color).toBe("var(--rpc-red)")
    expect(tab(container, "HOME").style.color).toBe("var(--rpc-text-secondary)")
  })

  it("pads the BAR itself for the home indicator, not just the body", () => {
    const { container } = render(<MobileNav />)
    // Asserted on the stylesheet: jsdom DROPS an inline `env(...)` value.
    const css = container.querySelector("nav.rpc-mobile-nav style")?.textContent ?? ""
    expect(css).toContain("padding-bottom: env(safe-area-inset-bottom")
    expect(css).toContain("box-sizing: content-box")
  })
})

describe("MobileNav — the active tab is announced, not just coloured", () => {
  it("marks the active tab with aria-current=page", () => {
    nav.pathname = "/nba-top-shot/collection"
    const { container } = render(<MobileNav />)
    expect(tab(container, "MY BINDER").getAttribute("aria-current")).toBe("page")
    expect(tab(container, "HOME").getAttribute("aria-current")).toBeNull()
    expect(tab(container, "SNIPER").getAttribute("aria-current")).toBeNull()
  })

  it("marks HOME on the homepage and nothing else", () => {
    nav.pathname = "/"
    const { container } = render(<MobileNav />)
    expect(tab(container, "HOME").getAttribute("aria-current")).toBe("page")
    expect(bar(container).querySelectorAll('[aria-current="page"]').length).toBe(1)
  })

  it("marks nothing on a page no tab leads to", () => {
    nav.pathname = "/nba-top-shot/overview"
    const { container } = render(<MobileNav />)
    expect(bar(container).querySelectorAll('[aria-current="page"]').length).toBe(0)
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
// Search left the bar on 2026-09-28 BECAUSE the header carries it. That is only
// true where the header is mounted — so pin the mounts on the surfaces that had
// NONE before that day (Trevor's screenshot: /dashboard with no top bar), plus
// the home header's own search box. Drop any of these and search silently
// vanishes from that surface on a phone.
describe("MobileNav — search lives in the header now", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

  it("the site header mounts on the account surfaces and /insights", () => {
    for (const p of [
      "app/dashboard/layout.tsx",
      "app/alerts/layout.tsx",
      "app/profile/page.tsx",
      "app/profile/edit/page.tsx",
      "app/insights/layout.tsx",
    ]) {
      expect(read(p), p).toContain("<GlobalSiteHeader />")
    }
  })

  it("the site header and the home header both carry the search box", () => {
    expect(read("components/GlobalSiteHeader.tsx")).toContain("<GlobalSearch />")
    expect(read("components/HomePageMarketing.tsx")).toContain("<GlobalSearch />")
  })
})
