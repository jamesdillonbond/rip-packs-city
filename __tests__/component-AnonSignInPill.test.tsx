// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// ─────────────────────────────────────────────────────────────────────────────
// AnonSignInPill — the anon-only "Sign in" affordance in the collection header
// (shipped with the 2026-07-17 un-gate). Its whole contract is: render NOTHING
// until auth state is known and for signed-in users, and render a /login link
// carrying ?next=<current path> for anon visitors. A regression that shows the
// pill to a signed-in user (or drops the ?next) is a visible header bug.
// ─────────────────────────────────────────────────────────────────────────────

const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  onChange: null as ((e: string, s: { user?: unknown } | null) => void) | null,
}))

vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseBrowser: () => ({
    auth: {
      getUser: async () => ({ data: { user: auth.user } }),
      onAuthStateChange: (cb: (e: string, s: { user?: unknown } | null) => void) => {
        auth.onChange = cb
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
    },
  }),
}))

const pathname = vi.hoisted(() => ({ value: "/nba-top-shot/collection" }))
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }))

import AnonSignInPill from "@/components/AnonSignInPill"

beforeEach(() => {
  auth.user = null
  auth.onChange = null
  pathname.value = "/nba-top-shot/collection"
})
afterEach(() => cleanup())

describe("AnonSignInPill", () => {
  it("renders a /login?next= link for an anonymous visitor", async () => {
    const { container } = render(<AnonSignInPill />)
    await waitFor(() => {
      const a = container.querySelector("a")
      expect(a).toBeTruthy()
      expect(a!.getAttribute("href")).toBe("/login?next=%2Fnba-top-shot%2Fcollection")
      expect(a!.textContent).toContain("Sign in")
    })
  })

  it("renders nothing for a signed-in user", async () => {
    auth.user = { id: "u1" }
    const { container } = render(<AnonSignInPill />)
    // Give the getUser promise a tick to resolve; it must stay empty.
    await waitFor(() => expect(container.querySelector("a")).toBeNull())
    // A subsequent sign-out event flips it to visible.
    auth.onChange?.("SIGNED_OUT", null)
    await waitFor(() => expect(container.querySelector("a")).toBeTruthy())
  })

  it("omits ?next when there is no pathname", async () => {
    pathname.value = ""
    const { container } = render(<AnonSignInPill />)
    await waitFor(() => {
      const a = container.querySelector("a")
      expect(a).toBeTruthy()
      expect(a!.getAttribute("href")).toBe("/login")
    })
  })
})
