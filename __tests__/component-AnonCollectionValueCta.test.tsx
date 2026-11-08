// @vitest-environment jsdom
//
// The Panini edition-page account prompt (2026-11-08) renders ONLY on a
// successful /api/profile/me read that says signed out. Signed in, a failed
// read, or a network error render nothing — a signed-in collector must never
// be asked to create the account they already have.
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"

const trackMock = vi.fn()
vi.mock("@/lib/track-funnel", () => ({ trackFunnelEvent: (...a: unknown[]) => trackMock(...a) }))
vi.mock("next/navigation", () => ({ usePathname: () => "/panini-blockchain/edition/packcard-1" }))

import AnonCollectionValueCta from "@/components/auth/AnonCollectionValueCta"

function mockMe(res: { ok: boolean; body?: unknown } | "throw") {
  globalThis.fetch = vi.fn(() =>
    res === "throw"
      ? Promise.reject(new Error("net"))
      : Promise.resolve({ ok: res.ok, json: () => Promise.resolve(res.body) } as Response),
  ) as typeof fetch
}

afterEach(() => {
  cleanup()
  trackMock.mockReset()
})

describe("AnonCollectionValueCta", () => {
  it("shows the prompt to a signed-out reader and returns them to this page after sign-up", async () => {
    mockMe({ ok: true, body: { user: null } })
    const { container } = render(<AnonCollectionValueCta identityNoun="Panini username" surface="panini_edition" />)
    await waitFor(() => expect(container.querySelector("[data-rpc-anon-value-cta]")).not.toBeNull())
    expect(container.textContent).toMatch(/Add your Panini username/)
    const a = container.querySelector("a")!
    const href = a.getAttribute("href") ?? ""
    expect(new URLSearchParams(href.split("?")[1]).get("intent")).toBe("signup")
    expect(new URLSearchParams(href.split("?")[1]).get("next")).toBe("/panini-blockchain/edition/packcard-1")
    fireEvent.click(a)
    expect(trackMock).toHaveBeenCalledWith({ eventType: "signin_click", surface: "panini_edition_signup" })
  })

  it("renders nothing for a signed-in reader", async () => {
    mockMe({ ok: true, body: { user: { id: "u" } } })
    const { container } = render(<AnonCollectionValueCta identityNoun="Panini username" surface="panini_edition" />)
    await new Promise((r) => setTimeout(r, 20))
    expect(container.querySelector("[data-rpc-anon-value-cta]")).toBeNull()
  })

  it("renders nothing when the session read fails or errors", async () => {
    mockMe({ ok: false })
    const a = render(<AnonCollectionValueCta identityNoun="Panini username" surface="panini_edition" />)
    mockMe("throw")
    const b = render(<AnonCollectionValueCta identityNoun="Panini username" surface="panini_edition" />)
    await new Promise((r) => setTimeout(r, 20))
    expect(a.container.querySelector("[data-rpc-anon-value-cta]")).toBeNull()
    expect(b.container.querySelector("[data-rpc-anon-value-cta]")).toBeNull()
  })
})
