// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import SalesHistoryCard from "@/components/analytics/SalesHistoryCard"

// Drives the wallet Sales History card: fetch /api/wallet-sales-history, the
// null-render on missing/empty, and the buy/sell table with side coloring + the
// null-safe player/set/serial/marketplace cells + the optional note.

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

describe("SalesHistoryCard", () => {
  it("renders the buy/sell table with the note and null-safe cells", async () => {
    fetchMock.mockReturnValueOnce(
      okJson({
        note: "Lower bound — only on-chain-recorded sales.",
        rows: [
          { side: "buy", player_name: "Ja Morant", set_name: "Base", serial_number: 12, price_usd: 250, marketplace: "topshot", sold_at: "2026-04-01T00:00:00Z" },
          { side: "sell", player_name: null, set_name: null, serial_number: null, price_usd: 0, marketplace: null, sold_at: null },
        ],
      }),
    )
    const { getByText, getAllByText } = render(<SalesHistoryCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(getByText("Ja Morant")).toBeTruthy())
    expect(getByText("Sales History")).toBeTruthy()
    expect(getByText(/Lower bound/)).toBeTruthy()
    expect(getByText("buy")).toBeTruthy()
    expect(getByText("sell")).toBeTruthy()
    expect(getByText("#12")).toBeTruthy()
    // the null row emits em-dashes (player/set/serial/marketplace/date)
    expect(getAllByText("—").length).toBeGreaterThanOrEqual(4)
    expect(fetchMock.mock.calls[0][0]).toContain("collection=nba-top-shot")
  })

  it("renders nothing when the wallet has no sales", async () => {
    fetchMock.mockReturnValueOnce(okJson({ rows: [] }))
    const { container } = render(<SalesHistoryCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing on a non-ok fetch", async () => {
    fetchMock.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500 } as Response))
    const { container } = render(<SalesHistoryCard wallet="0xW" urlSlug="nba-top-shot" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })
})
