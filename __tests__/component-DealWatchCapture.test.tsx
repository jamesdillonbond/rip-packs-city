// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import DealWatchCapture from "@/components/DealWatchCapture"

// Drives the anon email-capture band on /share/<wallet>: the client-side email
// gate (no "@" → error, NO network), the successful /api/subscribe POST + the
// email_capture_submitted funnel beacon + the "Check your inbox" success state,
// and the API-error + network-error legs. The capture payload contract
// (dealAlerts + wallet) is asserted so a silent field drop is caught.

const funnelMock = vi.fn()
vi.mock("@/lib/track-funnel", () => ({ trackFunnelEvent: (...a: unknown[]) => funnelMock(...a) }))

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  funnelMock.mockClear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Submit the form element directly so jsdom's native email-input constraint
// validation doesn't pre-empt the component's OWN validate branch.
function submit(container: HTMLElement) {
  fireEvent.submit(container.querySelector("form")!)
}

describe("DealWatchCapture", () => {
  it("rejects an email with no @ locally and does NOT hit the network", async () => {
    const { container, getByLabelText, getByText } = render(<DealWatchCapture wallet="0xW" />)
    fireEvent.change(getByLabelText("Email address"), { target: { value: "notanemail" } })
    submit(container)
    await waitFor(() => expect(getByText("Enter a valid email.")).toBeTruthy())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(funnelMock).not.toHaveBeenCalled()
  })

  it("POSTs the capture, fires the funnel event, and shows the inbox confirmation", async () => {
    fetchMock.mockReturnValueOnce(okJson({ success: true }))
    const { container, getByLabelText, getByText } = render(<DealWatchCapture wallet="0xWALLET" />)
    fireEvent.change(getByLabelText("Email address"), { target: { value: "  ME@Example.com  " } })
    submit(container)
    await waitFor(() => expect(getByText("Check your inbox ✉️")).toBeTruthy())

    // the POST carried the trimmed+lowercased email + the deal-watch payload
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/subscribe")
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({
      email: "me@example.com",
      walletAddress: "0xWALLET",
      dealAlerts: true,
      digestWeekly: true,
    })
    // funnel beacon fired once with the share surface + wallet
    expect(funnelMock).toHaveBeenCalledTimes(1)
    expect(funnelMock).toHaveBeenCalledWith({
      eventType: "email_capture_submitted",
      walletAddress: "0xWALLET",
      surface: "share",
    })
  })

  it("surfaces a server error and does NOT fire the funnel event", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: "already subscribed" }) } as Response),
    )
    const { container, getByLabelText, getByText } = render(<DealWatchCapture wallet="0xW" />)
    fireEvent.change(getByLabelText("Email address"), { target: { value: "me@x.com" } })
    submit(container)
    await waitFor(() => expect(getByText("already subscribed")).toBeTruthy())
    expect(funnelMock).not.toHaveBeenCalled()
  })

  it("shows a network-error message on a thrown fetch", async () => {
    fetchMock.mockReturnValueOnce(Promise.reject(new Error("down")))
    const { container, getByLabelText, getByText } = render(<DealWatchCapture wallet="0xW" />)
    fireEvent.change(getByLabelText("Email address"), { target: { value: "me@x.com" } })
    submit(container)
    await waitFor(() => expect(getByText("Network error — try again.")).toBeTruthy())
  })
})
