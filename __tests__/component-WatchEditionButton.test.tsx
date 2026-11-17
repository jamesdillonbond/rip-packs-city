// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import WatchEditionButton from "@/components/alerts/WatchEditionButton"

let fetchMock: ReturnType<typeof vi.fn>

function resp(status: number, body: unknown = {}) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response)
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const props = { editionKey: "1:2", collectionId: "cid", playerName: "LeBron", setName: "Base" }

function open(container: HTMLElement) {
  fireEvent.click(container.querySelector("button")!)
}

describe("WatchEditionButton", () => {
  it("renders a collapsed trigger with the custom label", () => {
    const { container } = render(<WatchEditionButton {...props} label="Track it" />)
    expect(container.textContent).toContain("Track it")
    // form not open yet
    expect(container.querySelector("select")).toBeNull()
  })

  it("expands into the form and can be closed", () => {
    const { container, getByLabelText } = render(<WatchEditionButton {...props} />)
    open(container)
    expect(container.querySelector("select")).not.toBeNull()
    expect(container.textContent).toContain("Alert me when…")
    fireEvent.click(getByLabelText("Close"))
    expect(container.querySelector("select")).toBeNull()
  })

  it("rejects a non-positive threshold without calling the API", async () => {
    const { container, getByText } = render(<WatchEditionButton {...props} />)
    open(container)
    fireEvent.change(container.querySelector('input[type="number"]')!, { target: { value: "0" } })
    fireEvent.click(getByText("Set alert"))
    expect(container.textContent).toContain("Enter a positive number.")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("POSTs the alert and shows success on 200", async () => {
    fetchMock.mockReturnValue(resp(200, { ok: true }))
    const { container, getByText } = render(<WatchEditionButton {...props} />)
    open(container)
    fireEvent.change(container.querySelector('input[type="number"]')!, { target: { value: "50" } })
    fireEvent.click(getByText("Set alert"))
    await waitFor(() => expect(container.textContent).toContain("Alert set."))
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    // owner_key is NEVER sent by the client (resolved server-side)
    expect(body).not.toHaveProperty("owner_key")
    expect(body.edition_key).toBe("1:2")
    expect(body.threshold).toBe(50)
    expect(body.alert_type).toBe("price_below")
  })

  it("treats the proxy's 307→/login→405 shape as sign-in, not as a failed save (anon POST, 2026-09-04)", async () => {
    // fetch follows the proxy's 307 to /login; the client sees POST /login → 405, redirected.
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: false, status: 405, redirected: true, json: () => Promise.reject(new Error("html")) } as unknown as Response),
    )
    const { container } = render(<WatchEditionButton {...props} />)
    open(container)
    fireEvent.change(container.querySelector("input[type=number]")!, { target: { value: "50" } })
    fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => /set alert/i.test(b.textContent ?? ""))!)
    await waitFor(() => expect(container.textContent).toContain("Sign in to set an alert."))
    expect(container.textContent).not.toContain("Could not save the alert.")
    expect(container.querySelector('a[href^="/login"]')).not.toBeNull()
  })

  it("shows the sign-in prompt on 401", async () => {
    fetchMock.mockReturnValue(resp(401))
    const { container, getByText } = render(<WatchEditionButton {...props} />)
    open(container)
    fireEvent.change(container.querySelector('input[type="number"]')!, { target: { value: "50" } })
    fireEvent.click(getByText("Set alert"))
    await waitFor(() => expect(container.textContent).toContain("Sign in to set an alert."))
    expect(container.querySelector('a[href^="/login"]')).not.toBeNull()
  })

  it("surfaces a server error message on non-ok", async () => {
    fetchMock.mockReturnValue(resp(500, { error: "boom" }))
    const { container, getByText } = render(<WatchEditionButton {...props} />)
    open(container)
    fireEvent.change(container.querySelector('input[type="number"]')!, { target: { value: "50" } })
    fireEvent.click(getByText("Set alert"))
    await waitFor(() => expect(container.textContent).toContain("boom"))
  })

  it("shows a network-error message when fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("offline"))
    const { container, getByText } = render(<WatchEditionButton {...props} />)
    open(container)
    fireEvent.change(container.querySelector('input[type="number"]')!, { target: { value: "50" } })
    fireEvent.click(getByText("Set alert"))
    await waitFor(() => expect(container.textContent).toContain("Network error. Try again."))
  })

  it("switching alert type flips the unit label between $ and %", () => {
    const { container } = render(<WatchEditionButton {...props} />)
    open(container)
    // default price_below → $
    expect(container.textContent).toContain("$")
    fireEvent.change(container.querySelector("select")!, { target: { value: "discount_above" } })
    // discount_above → %, and the telegram/percent hint path
    expect(container.querySelector('input[type="number"]')?.getAttribute("placeholder")).toContain("25")
  })

  it("selecting the telegram channel reveals the linking note", () => {
    const { container, getByText } = render(<WatchEditionButton {...props} />)
    open(container)
    fireEvent.click(getByText("telegram"))
    expect(container.textContent).toContain("Link Telegram")
  })
})
