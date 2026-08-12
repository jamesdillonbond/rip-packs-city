// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import RecentWhaleTrades from "@/components/analytics/RecentWhaleTrades"

// Drives the Recent Whale Trades card: fetch /api/analytics/sales/top-moves,
// loading skeleton → empty → ranked list with fmtUsd banding ($M/$k/$), the
// friendly collection label, the null player/set fallbacks, and the tier chip.

vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

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

const rows = [
  {
    rank: 1,
    transaction_hash: "0xhash1",
    edition_id: "e1",
    collection: "topshot",
    player_name: "LeBron James",
    set_name: "Base Set",
    tier: "LEGENDARY",
    serial_number: 23,
    price_usd: 1_500_000, // → $1.50M
    sold_at: "2026-04-15T00:00:00Z",
  },
  {
    rank: 2,
    transaction_hash: "0xhash2",
    edition_id: "e2",
    collection: "ufc",
    player_name: null, // → "Unknown moment"
    set_name: null, // → "—"
    tier: null,
    serial_number: null,
    price_usd: 4200, // → $4.2k
    sold_at: "2026-04-14T00:00:00Z",
  },
]

describe("RecentWhaleTrades", () => {
  it("shows the loading skeleton before data arrives", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {})) // never resolves
    const { container, queryByText } = render(<RecentWhaleTrades />)
    expect(queryByText("No recent whale trades.")).toBeNull()
    expect(container.querySelector(".animate-pulse")).toBeTruthy()
  })

  it("renders the ranked list with money banding, labels, and null fallbacks", async () => {
    fetchMock.mockReturnValueOnce(okJson({ rows }))
    const { getByText } = render(<RecentWhaleTrades />)
    await waitFor(() => expect(getByText("LeBron James")).toBeTruthy())
    expect(getByText("$1.50M")).toBeTruthy()
    expect(getByText("$4.2k")).toBeTruthy()
    expect(getByText("Unknown moment")).toBeTruthy() // null player fallback
    expect(getByText("LEGENDARY")).toBeTruthy() // tier chip
    // collection label mapping (topshot → Top Shot) appears in the subtitle
    expect(getByText(/Top Shot/)).toBeTruthy()
  })

  it("shows the empty state when there are no trades", async () => {
    fetchMock.mockReturnValueOnce(okJson({ rows: [] }))
    const { getByText } = render(<RecentWhaleTrades />)
    await waitFor(() => expect(getByText("No recent whale trades.")).toBeTruthy())
  })

  it("degrades honestly on a non-ok fetch (no crash)", async () => {
    // Previously asserted "No recent whale trades." — a 500 reported as an
    // absence of whale activity. The sibling test above still pins that copy
    // for the case where it is TRUE (a successful empty read).
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500 } as Response))
    const { getByText, container } = render(<RecentWhaleTrades />)
    await waitFor(() => expect(getByText(/Couldn't load recent whale trades/)).toBeTruthy())
    expect(container.textContent).not.toContain("No recent whale trades.")
  })
})
