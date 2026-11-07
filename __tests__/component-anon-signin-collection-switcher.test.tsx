// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// The header's anon "Sign In" (components/auth/SignOutButton.tsx — it carries
// ?next=<path> so login returns the visitor where they were; until 2026-11-06
// that lived on a SECOND pill in the collection banner, AnonSignInPill, which
// is retired) and CollectionSwitcher (derives the current page type from the
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

import SignOutButton from "@/components/auth/SignOutButton"
import CollectionSwitcher from "@/components/CollectionSwitcher"

beforeEach(() => {
  pathname = "/nba-top-shot/sniper"
  authState.user = null
})
afterEach(() => {
  cleanup()
})

describe("header Sign In (SignOutButton, anonymous)", () => {
  const profileMe = vi.hoisted(() => ({ user: null as null | { email: string } }))
  beforeEach(() => {
    profileMe.user = null
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ user: profileMe.user }) })))
  })
  afterEach(() => vi.unstubAllGlobals())

  // 2026-11-07: the anonymous header is "Sign in" + CREATE FREE ACCOUNT (AccountCta);
  // both carry the return path, the signup one as /login?intent=signup&next=.
  it("renders Sign in + Create free account, both carrying ?next=<current path>, for an anonymous visitor", async () => {
    const { findByText } = render(<SignOutButton />)
    const link = await findByText("Sign in")
    expect(link.getAttribute("href")).toBe("/login?next=%2Fnba-top-shot%2Fsniper")
    const create = await findByText("Create free account")
    expect(create.getAttribute("href")).toBe("/login?intent=signup&next=%2Fnba-top-shot%2Fsniper")
  })

  it("never names an auth page as the return target", async () => {
    pathname = "/login"
    const { findByText } = render(<SignOutButton />)
    const link = await findByText("Sign in")
    expect(link.getAttribute("href")).toBe("/login")
    expect((await findByText("Create free account")).getAttribute("href")).toBe("/login?intent=signup")
  })

  it("renders no Sign In link for a signed-in user", async () => {
    profileMe.user = { email: "collector@example.com" }
    const { container, findByText } = render(<SignOutButton />)
    await findByText("CO")
    expect(Array.from(container.querySelectorAll("a")).some((a) => a.getAttribute("href")?.startsWith("/login"))).toBe(false)
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
    // RE-PINNED 2026-09-25: this used "sets", and every published collection
    // now has a Sets tab (Pinnacle 09-20, Candy MLB 09-25), so no chip was
    // disabled. "packs" is still missing on Candy MLB and UFC — the property
    // stays exercised by subjects that genuinely lack the page.
    pathname = "/nba-top-shot/packs"
    const { container } = render(<CollectionSwitcher activeCollectionId="nba-top-shot" />)
    const disabled = container.querySelector('[aria-disabled="true"]')
    expect(disabled).toBeTruthy()
    expect(disabled?.getAttribute("title")).toMatch(/doesn't have a packs page/i)
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

// IA Phase 2 (2026-11-06): the header carries the collection chip at md+, so
// the page row is phone-only — otherwise every collection page shows the same
// seven destinations twice, one row apart.
describe("CollectionSwitcher — phone-only once the header has the chip", () => {
  it("hides its row at md+ in its own stylesheet, and keeps it below", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("components/CollectionSwitcher.tsx", "utf8")
    expect(src).toContain('className="rpc-collection-switcher-row"')
    expect(src).toMatch(/@media \(min-width: 768px\) \{ \.rpc-collection-switcher-row \{ display: none !important; \} \}/)
    // the header chip must exist for this to be safe
    const nav = readFileSync("components/TopNav.tsx", "utf8")
    expect(nav).toContain('data-tour-anchor="collection-switcher"')
  })
})
