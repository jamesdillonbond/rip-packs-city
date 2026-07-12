// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import InsiderSignals from "@/components/analytics/InsiderSignals"

let fetchMock: ReturnType<typeof vi.fn>

function mockResp(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)
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

describe("InsiderSignals", () => {
  it("renders nothing until data arrives, and nothing when has_data is false", async () => {
    fetchMock.mockReturnValue(mockResp({ has_data: false, alerts: [], buybacks: [], announcements: [] }))
    const { container } = render(<InsiderSignals />)
    // Initial (pre-fetch) render is null.
    expect(container.textContent).toBe("")
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // has_data=false keeps it null.
    expect(container.textContent).toBe("")
  })

  it("renders the panel with alerts, buybacks and announcements when has_data is true", async () => {
    fetchMock.mockReturnValue(
      mockResp({
        has_data: true,
        alerts: [
          { id: "a1", severity: 3, title: "Whale accumulation", summary: "Big buys", generated_at: new Date().toISOString() },
        ],
        buybacks: [
          { id: "b1", player_name: "LeBron James", set_name: "Base Set", serial_number: 23, price_usd: 1500, sold_at: new Date().toISOString() },
        ],
        announcements: [
          { id: "n1", source: "Reddit", title: "New set drop", posted_at: new Date().toISOString(), source_url: "https://x.test" },
        ],
      })
    )
    const { container } = render(<InsiderSignals />)
    await waitFor(() => expect(container.textContent).toContain("Insider Signals"))
    const txt = container.textContent!
    expect(txt).toContain("Whale accumulation")
    expect(txt).toContain("LeBron James")
    expect(txt).toContain("Base Set")
    // fmtUsd(1500) -> $1.5k
    expect(txt).toContain("$1.5k")
    expect(txt).toContain("New set drop")
    expect(txt).toContain("Reddit")
  })

  it("filters out buybacks with no resolved player name (defensive net)", async () => {
    fetchMock.mockReturnValue(
      mockResp({
        has_data: true,
        alerts: [],
        buybacks: [
          { id: "b1", player_name: "", set_name: "s", serial_number: 1, price_usd: 100, sold_at: null },
          { id: "b2", player_name: "   ", set_name: "s", serial_number: 2, price_usd: 200, sold_at: null },
        ],
        announcements: [],
      })
    )
    const { container } = render(<InsiderSignals />)
    await waitFor(() => expect(container.textContent).toContain("Insider Signals"))
    // Both buybacks are blank-named -> empty-state copy, no "buyback detected" cards.
    expect(container.textContent).toContain("No recent buybacks detected.")
    expect(container.textContent).not.toContain("Insider buyback detected")
  })

  it("shows per-section empty states when arrays are empty", async () => {
    fetchMock.mockReturnValue(
      mockResp({ has_data: true, alerts: [], buybacks: [], announcements: [] })
    )
    const { container } = render(<InsiderSignals />)
    await waitFor(() => expect(container.textContent).toContain("Insider Signals"))
    const txt = container.textContent!
    expect(txt).toContain("No active alerts.")
    expect(txt).toContain("No recent buybacks detected.")
    expect(txt).toContain("No recent announcements.")
  })
})
