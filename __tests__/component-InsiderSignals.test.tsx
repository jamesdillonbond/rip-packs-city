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
    // ⚠ INVERTED, NOT DELETED. This case used to assert "No recent buybacks
    // detected." here, and it was a well-reasoned test: the cards must not
    // render, which is still true and still asserted below. But the copy it
    // pinned makes a claim about the MARKET out of a gap in OUR CATALOGUE —
    // these two rows WERE read, we simply could not name them — so the
    // assertion held the defect in place. A name filter is not an emptiness
    // test; deleting the case would lose the half that was right.
    expect(container.textContent).not.toContain("Insider buyback detected")
    expect(container.textContent).not.toContain("No recent buybacks detected.")
    expect(container.textContent).toContain("2 recent buybacks not yet matched to a moment.")
  })

  it("says NOTHING WAS DETECTED only when the feed really returned no buybacks", async () => {
    // The other side of the same distinction: an empty array is an honest
    // market claim and must keep reading as one, or the fix just moves the
    // dishonesty and cries wolf on a quiet market.
    fetchMock.mockReturnValue(
      mockResp({ has_data: true, alerts: [], buybacks: [], announcements: [] })
    )
    const { container } = render(<InsiderSignals />)
    await waitFor(() => expect(container.textContent).toContain("Insider Signals"))
    expect(container.textContent).toContain("No recent buybacks detected.")
    expect(container.textContent).not.toContain("not yet matched to a moment")
  })

  it("singularises the unnameable count", async () => {
    fetchMock.mockReturnValue(
      mockResp({
        has_data: true,
        alerts: [],
        buybacks: [{ id: "b1", player_name: null, set_name: "s", serial_number: 1, price_usd: 100, sold_at: null }],
        announcements: [],
      })
    )
    const { container } = render(<InsiderSignals />)
    await waitFor(() => expect(container.textContent).toContain("Insider Signals"))
    expect(container.textContent).toContain("1 recent buyback not yet matched to a moment.")
  })

  it("discloses a PARTIAL drop instead of silently serving a shorter list", async () => {
    // The named row renders, so the panel looks complete — which is exactly why
    // the dropped one has to be stated. A list silently missing rows is a
    // truncated ranking served as the whole set.
    fetchMock.mockReturnValue(
      mockResp({
        has_data: true,
        alerts: [],
        buybacks: [
          { id: "b1", player_name: "Ja Morant", set_name: "Base", serial_number: 7, price_usd: 100, sold_at: null },
          { id: "b2", player_name: "", set_name: "s", serial_number: 2, price_usd: 200, sold_at: null },
        ],
        announcements: [],
      })
    )
    const { container } = render(<InsiderSignals />)
    await waitFor(() => expect(container.textContent).toContain("Insider Signals"))
    expect(container.textContent).toContain("Ja Morant")
    expect(container.textContent).toContain("+1 not yet matched to a moment")
    // Still not an emptiness claim — rows DID render.
    expect(container.textContent).not.toContain("No recent buybacks detected.")
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

  it("stays null when the fetch responds non-ok (r.ok=false -> null body)", async () => {
    fetchMock.mockReturnValue(mockResp({ has_data: true, alerts: [], buybacks: [], announcements: [] }, false))
    const { container } = render(<InsiderSignals />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // r.ok=false maps to null, so resp stays null and nothing renders.
    expect(container.textContent).toBe("")
  })

  it("formats the full fmtUsd ladder ($M / $XX / cents) and the — floor for non-positive", async () => {
    fetchMock.mockReturnValue(
      mockResp({
        has_data: true,
        alerts: [],
        buybacks: [
          { id: "m", player_name: "Millions", set_name: null, serial_number: null, price_usd: 2_500_000, sold_at: null },
          { id: "h", player_name: "Hundreds", set_name: null, serial_number: null, price_usd: 250, sold_at: null },
          { id: "c", player_name: "Cents", set_name: null, serial_number: null, price_usd: 4.2, sold_at: null },
          { id: "z", player_name: "Zero", set_name: null, serial_number: null, price_usd: 0, sold_at: null },
        ],
        announcements: [],
      })
    )
    const { container } = render(<InsiderSignals />)
    await waitFor(() => expect(container.textContent).toContain("Insider Signals"))
    const txt = container.textContent!
    expect(txt).toContain("$2.50M") // >= 1_000_000
    expect(txt).toContain("$250")   // >= 100, no k
    expect(txt).toContain("$4.20")  // < 100 cents
    expect(txt).toContain("—")      // <= 0 -> em-dash
    // set_name / serial_number null omit the "·" fragments (no crash).
    expect(txt).toContain("Millions")
    expect(txt).not.toContain("·")
  })

  it("renders severity-2 (warning) and null-severity (info) alert dots plus the title/summary fallbacks", async () => {
    fetchMock.mockReturnValue(
      mockResp({
        has_data: true,
        alerts: [
          { id: "s2", severity: 2, title: null, summary: null, generated_at: null },
          { id: "s0", severity: null, title: "Info alert", summary: "has summary", generated_at: null },
        ],
        buybacks: [],
        announcements: [],
      })
    )
    const { container } = render(<InsiderSignals />)
    await waitFor(() => expect(container.textContent).toContain("Insider Signals"))
    expect(container.innerHTML).toContain("var(--rpc-warning)") // severity 2
    expect(container.innerHTML).toContain("var(--rpc-info)")    // severity null -> else branch
    expect(container.textContent).toContain("Insider alert")    // null title fallback
    expect(container.textContent).toContain("Info alert")
    expect(container.textContent).toContain("has summary")
    // generated_at null -> fmtRelative returns "—"
    expect(container.textContent).toContain("—")
  })

  it("renders fmtRelative hour/day/ISO buckets and announcement fallbacks", async () => {
    const now = Date.now()
    const hours3 = new Date(now - 3 * 3_600_000).toISOString()
    const days2 = new Date(now - 2 * 86_400_000).toISOString()
    const oldIso = new Date(now - 60 * 86_400_000).toISOString()
    fetchMock.mockReturnValue(
      mockResp({
        has_data: true,
        alerts: [
          { id: "a", severity: 1, title: "T", summary: null, generated_at: hours3 },
        ],
        buybacks: [
          { id: "b", player_name: "Someone", set_name: "Set", serial_number: 7, price_usd: 900, sold_at: days2 },
        ],
        announcements: [
          // source null + title null + source_url null exercise all announcement fallbacks
          { id: "n1", source: null, title: null, posted_at: oldIso, source_url: null },
          { id: "n2", source: "Reddit", title: "Has link", posted_at: hours3, source_url: "https://x.test" },
        ],
      })
    )
    const { container } = render(<InsiderSignals />)
    await waitFor(() => expect(container.textContent).toContain("Insider Signals"))
    const txt = container.textContent!
    expect(txt).toContain("3h ago")   // hr < 24
    expect(txt).toContain("2d ago")   // day < 30
    expect(txt).toContain(oldIso.slice(0, 10)) // >= 30d -> ISO date slice
    expect(txt).toContain("Announcement") // null title fallback
    expect(txt).toContain("Set")           // buyback set_name present
    expect(txt).toContain("#7")            // buyback serial present
    expect(txt).toContain("Open")          // source_url present -> Open link
  })
})
