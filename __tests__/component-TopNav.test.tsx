// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// TopNav is the desktop primary nav. It carries two branches only a test can pin:
//   1. Auth-gated links — a signed-out visitor sees the 7 public destinations;
//      a signed-in user additionally gets "My Teams" and "Alerts" (both bounce
//      anon to /login, so surfacing them logged-out would be a dead end). The
//      signed-in state is read from the supabase browser client on mount and
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
import { publishedCollections } from "@/lib/collections"

const labels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("a")).map((a) => a.textContent)

beforeEach(() => {
  pathname = "/"
  authState.user = null
  authChangeCb = null
})
afterEach(() => cleanup())

describe("TopNav — auth-gated links", () => {
  it("shows only the public links to an anonymous visitor", async () => {
    authState.user = null
    const { container } = render(<TopNav />)
    await waitFor(() => {}) // let getUser resolve
    const ls = labels(container)
    expect(ls).toContain("Top Shot")
    expect(ls).toContain("Analytics")
    expect(ls).toContain("Blog")
    expect(ls).not.toContain("My Teams")
    expect(ls).not.toContain("Alerts")
    // 2026-09-06: the collection links are DERIVED from publishedCollections()
    // (the hand-written list omitted Candy MLB the day it published) — one link
    // per published collection + Analytics + Blog. UFC keeps its nav label.
    expect(ls).toContain("Candy")
    expect(ls).toContain("UFC")
    expect(ls.length).toBe(publishedCollections().length + 2)
  })

  it("adds My Teams + Alerts once the user is signed in", async () => {
    authState.user = { id: "u1" }
    const { container } = render(<TopNav />)
    await waitFor(() => {
      expect(labels(container)).toContain("My Teams")
    })
    const ls = labels(container)
    expect(ls).toContain("Alerts")
    expect(ls.length).toBe(publishedCollections().length + 4)
  })

  it("reacts to a later auth-state change (sign-in after mount)", async () => {
    authState.user = null
    const { container } = render(<TopNav />)
    await waitFor(() => {}) // initial getUser (anon)
    expect(labels(container)).not.toContain("My Teams")
    // Simulate a live sign-in event through the subscribed callback.
    authChangeCb?.("SIGNED_IN", { user: { id: "u1" } })
    await waitFor(() => {
      expect(labels(container)).toContain("My Teams")
    })
  })

  it("unsubscribes from auth changes on unmount", async () => {
    const { unmount } = render(<TopNav />)
    await waitFor(() => {})
    unmount()
    expect(onAuthUnsub).toHaveBeenCalled()
  })
})

describe("TopNav — active-route detection", () => {
  it("marks the tab active on an exact matchPrefix and on a nested path", () => {
    pathname = "/nba-top-shot/sniper"
    const { container } = render(<TopNav />)
    const topShot = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent === "Top Shot",
    )!
    // Nested under /nba-top-shot → active styling (surface-hover bg token).
    expect(topShot.className).toContain("bg-[color:var(--rpc-surface-hover)]")
    // A different collection stays inactive (secondary text token).
    const golazos = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent === "Golazos",
    )!
    expect(golazos.className).toContain("text-[color:var(--rpc-text-secondary)]")
  })

  it("does NOT treat a lookalike prefix as a match", () => {
    // /nba-top-shot-x must not light the /nba-top-shot tab — the guard requires
    // an exact match or a real "/" boundary, not a bare startsWith.
    pathname = "/nba-top-shot-x/overview"
    const { container } = render(<TopNav />)
    const topShot = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent === "Top Shot",
    )!
    expect(topShot.className).toContain("text-[color:var(--rpc-text-secondary)]")
  })

  it("gives the active Analytics tab its distinct emerald styling", () => {
    pathname = "/analytics"
    const { container } = render(<TopNav />)
    const analytics = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent === "Analytics",
    )!
    expect(analytics.className).toContain("text-emerald-400")
  })
})
