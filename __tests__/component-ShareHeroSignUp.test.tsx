// @vitest-environment jsdom
//
// 2026-11-16: the account CTA under the share card's Total FMV hero. Signed-out
// viewers only (a signed-in viewer gets SaveToCollectionCTA), no flash before the
// session is known, and its clicks are counted as their own surface ("share_hero")
// so it can be compared with the bottom button ("share_cta").
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react"

const auth: { user: unknown; fail: boolean } = { user: null, fail: false }
vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseBrowser: () => ({
    auth: {
      getUser: async () => {
        if (auth.fail) throw new Error("network")
        return { data: { user: auth.user } }
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}))
const trackMock = vi.fn()
vi.mock("@/lib/track-funnel", () => ({ trackFunnelEvent: (...a: unknown[]) => trackMock(...a) }))

import ShareHeroSignUp from "@/app/share/[wallet]/ShareHeroSignUp"
import ShareSignUpLink from "@/app/share/[wallet]/ShareSignUpLink"

const W = "0xb4ce555fbc2ad619"
beforeEach(() => {
  auth.user = null
  auth.fail = false
  trackMock.mockClear()
})
afterEach(cleanup)

describe("ShareHeroSignUp", () => {
  it("signed out: shows the button, back to this card after login, counted as share_hero", async () => {
    const { container } = render(<ShareHeroSignUp wallet={W} />)
    const a = await waitFor(() => {
      const el = container.querySelector("a")
      if (!el) throw new Error("not yet")
      return el
    })
    expect(a.textContent).toContain("Save it to a free account")
    expect(a.getAttribute("href")).toBe(`/login?intent=signup&next=${encodeURIComponent(`/share/${W}`)}`)
    fireEvent.click(a)
    expect(trackMock).toHaveBeenCalledWith(expect.objectContaining({ eventType: "signin_click", surface: "share_hero", walletAddress: W }))
  })

  it("signed in: renders nothing (their save button lives further down)", async () => {
    auth.user = { id: "u1" }
    const { container } = render(<ShareHeroSignUp wallet={W} />)
    await act(async () => {})
    expect(container.querySelector("[data-rpc-share-hero-signup]")).toBeNull()
  })

  it("a failed session read renders nothing — never assumes signed out", async () => {
    auth.fail = true
    const { container } = render(<ShareHeroSignUp wallet={W} />)
    await act(async () => {})
    expect(container.querySelector("[data-rpc-share-hero-signup]")).toBeNull()
  })

  it("renders nothing before the session is known (no flash)", () => {
    const { container } = render(<ShareHeroSignUp wallet={W} />)
    expect(container.querySelector("[data-rpc-share-hero-signup]")).toBeNull()
  })
})

describe("ShareSignUpLink default surface is unchanged", () => {
  it("the bottom button still counts as share_cta", () => {
    const { container } = render(<ShareSignUpLink wallet={W} />)
    fireEvent.click(container.querySelector("a")!)
    expect(trackMock).toHaveBeenCalledWith(expect.objectContaining({ surface: "share_cta" }))
  })
})
