// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import StripeSubscribeButton from "@/components/pricing/StripeSubscribeButton"

// The Pro Monthly Checkout CTA. It is NOT static marketing copy — it drives a
// real fetch state machine to /api/stripe/checkout:
//   401           → redirect to /login?next=/pricing
//   ok + { url }  → redirect to Stripe Checkout
//   !ok           → inline error (route error or HTTP status)
//   thrown fetch  → inline error (network)
// A regression in any arm silently breaks the only paid-conversion path.

let fetchMock: ReturnType<typeof vi.fn>
let hrefSetTo: string[]

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  // Capture window.location.href assignments without navigating jsdom.
  hrefSetTo = []
  const loc = { href: "" }
  Object.defineProperty(loc, "href", {
    get: () => "",
    set: (v: string) => hrefSetTo.push(v),
  })
  Object.defineProperty(window, "location", { value: loc, writable: true, configurable: true })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const res = (init: { status: number; body?: unknown }) =>
  Promise.resolve({
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    json: () => Promise.resolve(init.body ?? {}),
  } as unknown as Response)

describe("StripeSubscribeButton", () => {
  it("redirects to the returned Checkout URL on success", async () => {
    fetchMock.mockReturnValueOnce(res({ status: 200, body: { url: "https://checkout.stripe.com/xyz" } }))
    const { getByRole } = render(<StripeSubscribeButton />)
    fireEvent.click(getByRole("button"))
    await waitFor(() => expect(hrefSetTo).toContain("https://checkout.stripe.com/xyz"))
  })

  it("redirects to /login (with next=/pricing) when the route returns 401", async () => {
    fetchMock.mockReturnValueOnce(res({ status: 401 }))
    const { getByRole } = render(<StripeSubscribeButton />)
    fireEvent.click(getByRole("button"))
    await waitFor(() =>
      expect(hrefSetTo.some((h) => h.startsWith("/login?next="))).toBe(true),
    )
  })

  it("surfaces the route error body when the response is not ok", async () => {
    fetchMock.mockReturnValueOnce(res({ status: 503, body: { error: "Stripe not configured" } }))
    const { getByRole, findByText } = render(<StripeSubscribeButton />)
    fireEvent.click(getByRole("button"))
    expect(await findByText("Stripe not configured")).toBeTruthy()
  })

  it("shows 'No checkout URL returned' when ok but the body has no url", async () => {
    fetchMock.mockReturnValueOnce(res({ status: 200, body: {} }))
    const { getByRole, findByText } = render(<StripeSubscribeButton />)
    fireEvent.click(getByRole("button"))
    expect(await findByText("No checkout URL returned")).toBeTruthy()
  })

  it("surfaces a thrown fetch (network error) inline", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"))
    const { getByRole, findByText } = render(<StripeSubscribeButton />)
    fireEvent.click(getByRole("button"))
    expect(await findByText("network down")).toBeTruthy()
  })
})
