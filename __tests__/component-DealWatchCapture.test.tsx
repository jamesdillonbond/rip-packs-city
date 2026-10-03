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

const trackMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/telemetry/track", () => ({ track: trackMock }))

// Captures the IntersectionObserver so a test can scroll the box into view.
const io = vi.hoisted(() => ({ cb: null as null | ((e: Array<{ isIntersecting: boolean }>) => void) }))
class FakeIO {
  constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) { io.cb = cb }
  observe() {}
  disconnect() {}
}

let fetchMock: ReturnType<typeof vi.fn>
const okJson = (b: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) } as Response)

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  funnelMock.mockClear()
  trackMock.mockClear()
  io.cb = null
  vi.stubGlobal("IntersectionObserver", FakeIO)
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

describe("DealWatchCapture — seen → engaged instrumentation", () => {
  it("logs deal-watch-shown only once it is actually in view, and only once", () => {
    render(<DealWatchCapture wallet="0xW" />)
    expect(trackMock).not.toHaveBeenCalled() // rendered below the fold is not "shown"
    io.cb!([{ isIntersecting: false }])
    expect(trackMock).not.toHaveBeenCalled()
    io.cb!([{ isIntersecting: true }])
    io.cb!([{ isIntersecting: true }])
    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith("deal-watch-shown", { surface: "share" })
  })

  it("a browser without IntersectionObserver logs no impression rather than a false one", () => {
    vi.stubGlobal("IntersectionObserver", undefined)
    render(<DealWatchCapture wallet="0xW" />)
    expect(io.cb).toBeNull()
    expect(trackMock).not.toHaveBeenCalled()
  })

  it("logs deal-watch-focus once on the first focus of the field", () => {
    const { getByLabelText } = render(<DealWatchCapture wallet="0xW" />)
    fireEvent.focus(getByLabelText("Email address"))
    fireEvent.blur(getByLabelText("Email address"))
    fireEvent.focus(getByLabelText("Email address"))
    expect(trackMock.mock.calls.filter((c) => c[0] === "deal-watch-focus")).toHaveLength(1)
  })
})

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

  it("a server error with no message (or a 200 that says success:false) gets the generic retry copy, never 'sent'", async () => {
    fetchMock.mockReturnValueOnce(
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: false }) } as Response),
    )
    const { container, getByLabelText, getByText, queryByText } = render(<DealWatchCapture wallet="0xW" />)
    fireEvent.change(getByLabelText("Email address"), { target: { value: "me@x.com" } })
    submit(container)
    await waitFor(() => expect(getByText("Something went wrong — try again.")).toBeTruthy())
    expect(queryByText(/Check your inbox/)).toBeNull()
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
