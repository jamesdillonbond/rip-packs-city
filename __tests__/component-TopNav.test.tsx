// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// IA Phase 2 (2026-11-06): TopNav renders the six job groups from lib/ia.ts
// (Market · Packs · Insights · Collectors · Trade · Me) with a hover/focus menu
// each, plus ONE collection-switcher chip instead of a link per collection.
// Earlier history (one tab per collection + Blog/Analytics/My Teams/Alerts) is
// below for the record; those pins are re-stated against the registry.
//
// TopNav is the desktop primary nav. It carries two branches only a test can pin:
//   1. Auth-gated links — a signed-out visitor sees the public destinations
//      (one per published collection + Blog); a signed-in user additionally gets
//      "Analytics", "My Teams" and "Alerts" (all three bounce anon to /login, so
//      surfacing them logged-out would be a dead end — /analytics did exactly
//      that until 2026-10-11: shown to anon, 307 → /login on click, review M7).
//      The signed-in state is read from the supabase browser client on mount and
//      kept live via onAuthStateChange.
//   2. Active-route detection — a link is active when the pathname equals its
//      matchPrefix OR sits beneath it (prefix + "/"), so /nba-top-shot/sniper
//      lights the "Top Shot" tab but /nba-top-shot-x would NOT.

let pathname = "/"
vi.mock("next/navigation", () => ({ usePathname: () => pathname }))

const authState = vi.hoisted(() => ({ user: null as unknown }))
let authChangeCb: ((event: string, session: unknown) => void) | null = null
const onAuthUnsub = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseBrowser: () => ({
    auth: {
      getUser: () => Promise.resolve({ data: { user: authState.user } }),
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        authChangeCb = cb
        return { data: { subscription: { unsubscribe: onAuthUnsub } } }
      },
    },
  }),
}))

import TopNav from "@/components/TopNav"
import { isPublicPath } from "@/proxy"
import { publishedCollections } from "@/lib/collections"
import { IA_GROUPS, visibleItems, resolveHref, DEFAULT_COLLECTION } from "@/lib/ia"

const labels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("a")).map((a) => a.textContent)

beforeEach(() => {
  pathname = "/"
  authState.user = null
  authChangeCb = null
})
afterEach(() => cleanup())

describe("TopNav — groups, by audience", () => {
  const groupLabels = (c: HTMLElement) => Array.from(c.querySelectorAll("a[data-ia-group]")).map((a) => a.textContent)

  it("anon sees the five public groups, never Me, and every href it can reach is public", async () => {
    authState.user = null
    const { container } = render(<TopNav />)
    await waitFor(() => {})
    expect(groupLabels(container)).toEqual(["Market", "Packs", "Insights", "Collectors", "Trade"])
    const ls = labels(container)
    expect(ls).not.toContain("My teams")
    expect(ls).not.toContain("Alerts")
    expect(ls).not.toContain("Trade room")
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href")!)
    for (const h of hrefs) expect(isPublicPath(h.split("?")[0], "GET"), `${h} must be public`).toBe(true)
  })

  it("signed in adds Me and the auth-only items (Alerts, My teams, Trade room, My pack history)", async () => {
    authState.user = { id: "u1" }
    const { container } = render(<TopNav />)
    await waitFor(() => expect(groupLabels(container)).toContain("Me"))
    const ls = labels(container)
    for (const l of ["Alerts", "My teams", "Trade room", "My pack history", "Dashboard"]) expect(ls).toContain(l)
  })

  it("no collection is a top-level destination: the seven collections are ONE switcher chip with a menu", async () => {
    const { container } = render(<TopNav />)
    await waitFor(() => {})
    const chip = container.querySelector('[data-tour-anchor="collection-switcher"]')!
    expect(chip.textContent).toContain("Top Shot")
    expect(chip.getAttribute("href")).toBe("/nba-top-shot/overview")
    const menu = container.querySelector('[role="menu"][aria-label="Collections"]')!
    const items = Array.from(menu.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(items).toEqual(publishedCollections().map((c) => `/${c.id}/overview`))
    expect(groupLabels(container)).not.toContain("Top Shot")
  })

  it("every group's menu lists exactly the registry's visible items, resolved to the current collection", async () => {
    pathname = "/nfl-all-day/market"
    authState.user = null
    const { container } = render(<TopNav />)
    await waitFor(() => {})
    for (const g of IA_GROUPS.filter((g) => !g.auth)) {
      const menu = container.querySelector(`[role="menu"][aria-label="${g.label}"]`)!
      const hrefs = Array.from(menu.querySelectorAll("a")).map((a) => a.getAttribute("href"))
      expect(hrefs, g.id).toEqual(visibleItems(g, false).map((i) => resolveHref(i.href, "nfl-all-day", i.page)))
    }
    // All Day has a packs page, so the Packs hub is All Day's; the chip follows the URL.
    expect(container.querySelector('a[data-ia-group="packs"]')!.getAttribute("href")).toBe("/nfl-all-day/packs")
    expect(container.querySelector('[data-tour-anchor="collection-switcher"]')!.textContent).toContain("All Day")
  })

  it("a collection without the page falls back to the default, never to a soft-404 (UFC has no packs)", async () => {
    pathname = "/ufc/sniper"
    const { container } = render(<TopNav />)
    await waitFor(() => {})
    expect(container.querySelector('a[data-ia-group="packs"]')!.getAttribute("href")).toBe(`/${DEFAULT_COLLECTION}/packs`)
  })

  it("reacts to a later auth-state change (sign-in after mount)", async () => {
    authState.user = null
    const { container } = render(<TopNav />)
    await waitFor(() => {})
    expect(groupLabels(container)).not.toContain("Me")
    authChangeCb?.("SIGNED_IN", { user: { id: "u1" } })
    await waitFor(() => {
      expect(groupLabels(container)).toContain("Me")
    })
  })

  it("unsubscribes from auth changes on unmount", async () => {
    const { unmount } = render(<TopNav />)
    await waitFor(() => {})
    unmount()
    expect(onAuthUnsub).toHaveBeenCalled()
  })

  it("menu links are never prefetched — ~40 of them ride every page", async () => {
    const { container } = render(<TopNav />)
    await waitFor(() => {})
    expect(container.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(20)
  })
})

describe("TopNav — active group", () => {
  const groupLink = (c: HTMLElement, id: string) => c.querySelector(`a[data-ia-group="${id}"]`)!

  it("lights the group that owns the path, including a nested path, and only that group", () => {
    pathname = "/trades/block"
    const { container } = render(<TopNav />)
    expect(groupLink(container, "trade").getAttribute("aria-current")).toBe("page")
    expect(groupLink(container, "market").getAttribute("aria-current")).toBeNull()
    expect(groupLink(container, "trade").className).toContain("bg-[color:var(--rpc-surface-hover)]")
  })

  it("does NOT treat a lookalike prefix as a match", () => {
    pathname = "/marketing"
    const { container } = render(<TopNav />)
    expect(groupLink(container, "market").getAttribute("aria-current")).toBeNull()
  })

  it("a collection page lights the group that owns its page type (packs), and nothing for a page no group owns", () => {
    pathname = "/nfl-all-day/packs"
    const a = render(<TopNav />)
    expect(groupLink(a.container, "packs").getAttribute("aria-current")).toBe("page")
    cleanup()
    pathname = "/nba-top-shot/badges"
    const b = render(<TopNav />)
    expect(b.container.querySelectorAll('a[data-ia-group][aria-current="page"]').length).toBe(0)
  })
})
