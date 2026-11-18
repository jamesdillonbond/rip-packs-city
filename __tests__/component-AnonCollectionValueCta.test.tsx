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
const usageMock = vi.fn()
vi.mock("@/lib/telemetry/track", () => ({ track: (...a: unknown[]) => usageMock(...a) }))

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
  usageMock.mockReset()
})

describe("AnonCollectionValueCta", () => {
  it("shows the prompt to a signed-out reader and returns them to this page after sign-up", async () => {
    mockMe({ ok: true, body: { user: null } })
    const { container } = render(<AnonCollectionValueCta identityNoun="Panini username" surface="panini_edition" />)
    await waitFor(() => expect(container.querySelector("[data-rpc-anon-value-cta]")).not.toBeNull())
    expect(container.textContent).toMatch(/Enter your Panini username/)
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

  // 2026-11-16: the prompt logs that it was SHOWN (once per page), so clicks ÷ shows
  // is readable; 30 days of 0 clicks could not say whether anyone saw it.
  it("logs one anon-value-cta-shown per page when it renders, and none when it does not", async () => {
    mockMe({ ok: true, body: { user: null } })
    const { container } = render(<AnonCollectionValueCta identityNoun="Top Shot username" itemNoun="moment" surface="topshot_edition" />)
    await waitFor(() => expect(container.querySelector("[data-rpc-anon-value-cta]")).not.toBeNull())
    expect(container.textContent).toMatch(/Own this moment\? Enter your Top Shot username/)
    expect(usageMock).toHaveBeenCalledWith("anon-value-cta-shown", { surface: "topshot_edition" })
    cleanup()
    render(<AnonCollectionValueCta identityNoun="Top Shot username" itemNoun="moment" surface="topshot_edition" />)
    await new Promise((r) => setTimeout(r, 20))
    expect(usageMock).toHaveBeenCalledTimes(1)
    mockMe({ ok: true, body: { user: { id: "u" } } })
    render(<AnonCollectionValueCta identityNoun="Dapper username" itemNoun="pin" surface="pinnacle_edition" />)
    await new Promise((r) => setTimeout(r, 20))
    expect(usageMock).toHaveBeenCalledTimes(1)
  })

  // 2026-11-17: the prompt leads with a no-account look-up — the identifier goes to this
  // collection's /collection?wallet= page, which runs the search. An empty box goes nowhere.
  it("offers a no-account look-up that opens this collection's page for the typed username", async () => {
    mockMe({ ok: true, body: { user: null } })
    const { container } = render(<AnonCollectionValueCta identityNoun="Panini username" surface="panini_edition" />)
    await waitFor(() => expect(container.querySelector("[data-rpc-anon-value-lookup]")).not.toBeNull())
    const form = container.querySelector("form")!
    expect(form.getAttribute("action")).toBe("/panini-blockchain/collection")
    expect(form.getAttribute("method")).toBe("get")
    const input = form.querySelector("input")!
    expect(input.getAttribute("name")).toBe("wallet")
    expect(container.textContent).toMatch(/No account needed/)
    fireEvent.submit(form)
    expect(usageMock).not.toHaveBeenCalledWith("anon-value-lookup", expect.anything())
    fireEvent.change(input, { target: { value: "knotbean" } })
    fireEvent.submit(form)
    expect(usageMock).toHaveBeenCalledWith("anon-value-lookup", { surface: "panini_edition" })
  })
})
