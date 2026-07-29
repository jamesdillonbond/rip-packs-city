// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import EmailDigestSubscribe from "@/components/profile/EmailDigestSubscribe"

// Drives the email-digest subscribe card: the email validation gate (no "@" →
// error, NO network), the /api/subscribe POST payload (email + wallet + the four
// digest toggles, with the digestWeekly-default-on), the success state, and the
// server-error surface.

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("EmailDigestSubscribe", () => {
  it("rejects an email with no @ and does not POST", () => {
    const { getByText, getByPlaceholderText } = render(<EmailDigestSubscribe walletAddress="0xW" />)
    fireEvent.change(getByPlaceholderText("you@example.com"), { target: { value: "nope" } })
    fireEvent.click(getByText("Subscribe"))
    expect(getByText("Enter a valid email")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("POSTs the email + wallet + default toggles and shows the subscribed state", async () => {
    fetchMock.mockReturnValueOnce(okJson({ success: true }))
    const { getByText, getByPlaceholderText } = render(<EmailDigestSubscribe walletAddress="0xWALLET" />)
    fireEvent.change(getByPlaceholderText("you@example.com"), { target: { value: "me@x.com" } })
    fireEvent.click(getByText("Subscribe"))
    await waitFor(() => expect(getByText("✓ Subscribed")).toBeTruthy())

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({
      email: "me@x.com",
      walletAddress: "0xWALLET",
      digestWeekly: true, // default on
      dealAlerts: false,
      badgeAlerts: false,
      portfolioAlerts: false,
    })
  })

  it("respects a toggled-on deal alert in the payload", async () => {
    fetchMock.mockReturnValueOnce(okJson({ success: true }))
    const { getByText, getByPlaceholderText } = render(<EmailDigestSubscribe walletAddress={null} />)
    fireEvent.change(getByPlaceholderText("you@example.com"), { target: { value: "me@x.com" } })
    // toggle Deal alerts on (it's the checkbox inside the "Deal alerts" label)
    fireEvent.click(getByText("Deal alerts").parentElement!.querySelector("input")!)
    fireEvent.click(getByText("Subscribe"))
    await waitFor(() => expect(getByText("✓ Subscribed")).toBeTruthy())
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.dealAlerts).toBe(true)
    expect(body.walletAddress).toBeNull()
  })

  it("surfaces a server error and stays on the form", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "already subscribed" }) } as Response),
    )
    const { getByText, getByPlaceholderText, queryByText } = render(<EmailDigestSubscribe walletAddress="0xW" />)
    fireEvent.change(getByPlaceholderText("you@example.com"), { target: { value: "me@x.com" } })
    fireEvent.click(getByText("Subscribe"))
    await waitFor(() => expect(getByText("already subscribed")).toBeTruthy())
    expect(queryByText("✓ Subscribed")).toBeNull()
  })
})
