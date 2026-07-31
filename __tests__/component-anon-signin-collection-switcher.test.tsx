// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// AnonSignInPill (renders a Sign-in CTA ONLY for anonymous visitors, carrying
// ?next=<path>) and CollectionSwitcher (derives the current page type from the
// URL and gates each collection chip on whether it supports that page).

let pathname = "/nba-top-shot/sniper"
vi.mock("next/navigation", () => ({ usePathname: () => pathname }))

const authState = vi.hoisted(() => ({ user: null as unknown }))
const onAuthUnsub = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseBrowser: () => ({
    auth: {
      getUser: () => Promise.resolve({ data: { user: authState.user } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: onAuthUnsub } } }),
    },
  }),
}))

import AnonSignInPill from "@/components/AnonSignInPill"
import CollectionSwitcher from "@/components/CollectionSwitcher"

beforeEach(() => {
  pathname = "/nba-top-shot/sniper"
  authState.user = null
})
afterEach(() => {
  cleanup()
})

describe("AnonSignInPill", () => {
  it("renders a Sign in link with ?next for an anonymous visitor", async () => {
    authState.user = null
    const { findByText } = render(<AnonSignInPill />)
    const link = await findByText("Sign in")
    expect(link.getAttribute("href")).toBe("/login?next=%2Fnba-top-shot%2Fsniper")
  })

  it("renders nothing for a signed-in user", async () => {
    authState.user = { id: "u1" }
    const { container } = render(<AnonSignInPill />)
    await waitFor(() => {}) // let the getUser promise resolve
    expect(container.querySelector("a")).toBeNull()
  })
})

describe("CollectionSwitcher", () => {
  it("renders a chip per published collection and links supported pages to that page", () => {
    pathname = "/nba-top-shot/sniper"
    const { container } = render(<CollectionSwitcher activeCollectionId="nba-top-shot" />)
    const links = Array.from(container.querySelectorAll("a"))
    expect(links.length).toBeGreaterThan(0)
    // All 5 published collections support "sniper", so each renders a link to /{id}/sniper
    for (const a of links) {
      expect(a.getAttribute("href")).toMatch(/\/sniper$/)
    }
  })

  it("disables (span, not link) a collection that lacks the current page", () => {
    // "sets" is not a Pinnacle page — its chip must be a disabled span.
    pathname = "/nba-top-shot/sets"
    const { container } = render(<CollectionSwitcher activeCollectionId="nba-top-shot" />)
    const disabled = container.querySelector('[aria-disabled="true"]')
    expect(disabled).toBeTruthy()
    expect(disabled?.getAttribute("title")).toMatch(/doesn't have a sets page/i)
  })

  it("falls back to overview when the path has no recognizable page segment", () => {
    pathname = "/nba-top-shot"
    const { container } = render(<CollectionSwitcher activeCollectionId="nba-top-shot" />)
    const links = Array.from(container.querySelectorAll("a"))
    for (const a of links) {
      expect(a.getAttribute("href")).toMatch(/\/overview$/)
    }
  })
})
