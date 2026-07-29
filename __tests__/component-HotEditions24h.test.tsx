// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import HotEditions24h from "@/components/HotEditions24h"

// Drives the Hot Editions · 24h board end-to-end: fetch /api/market/hot-editions,
// loading → err/empty/table, the null-name/set/tier "—" fallbacks (never a blank
// cell), fmtCurrency banding, and the collection filter that re-fetches (?slug=)
// and hides the Collection column.

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

const editions = [
  {
    edition_id: "e1",
    edition_key: "1:2",
    collection: "nba_top_shot",
    player_name: "Luka Dončić",
    set_name: "Base",
    tier: "COMMON",
    sales_24h: 9,
    volume_24h_usd: 4321, // → "$4,321"
    avg_price_24h: 480.25, // → "$480.25"
    min_price_24h: 100,
    max_price_24h: 900,
  },
  {
    edition_id: "e2",
    edition_key: null,
    collection: "ufc_strike",
    player_name: null, // → "—"
    set_name: null, // → "—"
    tier: null, // → "—"
    sales_24h: 2,
    volume_24h_usd: 50,
    avg_price_24h: 25,
    min_price_24h: 25,
    max_price_24h: 25,
  },
]

describe("HotEditions24h", () => {
  it("renders the table with money banding and null-safe player/set/tier", async () => {
    fetchMock.mockReturnValueOnce(okJson({ editions }))
    const { getByText, getAllByText } = render(<HotEditions24h />)
    await waitFor(() => expect(getByText("Luka Dončić")).toBeTruthy())
    expect(getByText("$4,321")).toBeTruthy()
    expect(getByText("$480.25")).toBeTruthy()
    // the null-name row emits em-dashes for player/set/tier
    expect(getAllByText("—").length).toBeGreaterThanOrEqual(3)
    expect(getByText("Top Shot")).toBeTruthy() // collection label, no slug
  })

  it("shows the empty state when there are no sales", async () => {
    fetchMock.mockReturnValueOnce(okJson({ editions: [] }))
    const { getByText } = render(<HotEditions24h />)
    await waitFor(() => expect(getByText("No sales in the last 24h.")).toBeTruthy())
  })

  it("degrades to empty + error text on a thrown fetch", async () => {
    fetchMock.mockReturnValueOnce(Promise.reject(new Error("network down")))
    const { getByText } = render(<HotEditions24h />)
    await waitFor(() => expect(getByText("network down")).toBeTruthy())
    expect(getByText("No sales in the last 24h.")).toBeTruthy()
  })

  it("collection filter re-fetches with ?slug= and hides the Collection column", async () => {
    fetchMock.mockReturnValue(okJson({ editions: [editions[0]] }))
    const { getByLabelText, queryByText } = render(<HotEditions24h />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.change(getByLabelText("Collection filter"), { target: { value: "ufc_strike" } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1][0]).toContain("slug=ufc_strike")
    await waitFor(() => expect(queryByText("Top Shot")).toBeNull())
  })
})
