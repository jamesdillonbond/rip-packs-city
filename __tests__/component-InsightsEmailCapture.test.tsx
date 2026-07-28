// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react"
import InsightsEmailCapture from "@/components/insights/InsightsEmailCapture"

// Pins the anon lead-capture band on the public /insights surfaces — the
// top-of-funnel email capture. Untested, this whole subtree (components/insights)
// could rot. Guards: the client-side email validation gate (a bad email never
// hits the network), the POST payload contract to /api/subscribe, and the three
// terminal states (sent / server-error / network-error) so a signup failure is
// shown honestly rather than swallowed.

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const type = (value: string) =>
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value } })
const submit = () => fireEvent.click(screen.getByRole("button", { name: /Subscribe/i }))

describe("InsightsEmailCapture — validation gate", () => {
  // The input is type="email" required, so a syntactically-invalid or empty
  // value is blocked by native constraint validation before submit — either way
  // the observable contract is the same: no email leaves the browser.
  it("does not POST when the email is malformed", () => {
    render(<InsightsEmailCapture />)
    type("not-an-email")
    submit()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does not POST when the email is empty", () => {
    render(<InsightsEmailCapture />)
    submit()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("InsightsEmailCapture — submit", () => {
  it("POSTs a trimmed lowercased email + digestWeekly and shows the confirmation state", async () => {
    render(<InsightsEmailCapture />)
    type("  Trevor@Example.COM  ")
    submit()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/subscribe")
    expect(init.method).toBe("POST")
    const body = JSON.parse(init.body)
    expect(body.email).toBe("trevor@example.com")
    expect(body.digestWeekly).toBe(true)
    await waitFor(() => expect(screen.getByText(/Check your inbox/i)).toBeTruthy())
  })

  it("surfaces a server-provided error message on a non-ok response", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "already subscribed" }), { status: 409 }))
    render(<InsightsEmailCapture />)
    type("dupe@example.com")
    submit()
    await waitFor(() => expect(screen.getByText("already subscribed")).toBeTruthy())
  })

  it("treats an ok response carrying success:false as an error (not a false confirmation)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 200 }))
    render(<InsightsEmailCapture />)
    type("x@example.com")
    submit()
    await waitFor(() => expect(screen.getByText(/went wrong/i)).toBeTruthy())
    expect(screen.queryByText(/Check your inbox/i)).toBeNull()
  })

  it("shows a network-error message when fetch throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"))
    render(<InsightsEmailCapture />)
    type("x@example.com")
    submit()
    await waitFor(() => expect(screen.getByText(/Network error/i)).toBeTruthy())
  })
})
