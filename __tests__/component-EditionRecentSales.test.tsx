// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import EditionRecentSales from "@/components/collection/EditionRecentSales"

// Drives the moment-row recent-sales strip: the no-editionKey short-circuit
// ("—", no fetch), the loading state, the /api/recent-sales fetch → serial +
// price rows, and the no-sales empty state.

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

describe("EditionRecentSales", () => {
  it("short-circuits with a dash and no fetch when editionKey is null", () => {
    const { getByText } = render(<EditionRecentSales editionKey={null} />)
    expect(getByText("Recent Sales")).toBeTruthy()
    expect(getByText("—")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows the loading placeholder before data arrives", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {})) // never resolves
    const { getByText } = render(<EditionRecentSales editionKey="1:2" />)
    expect(getByText("Loading sales...")).toBeTruthy()
  })

  it("renders serial + price rows once loaded", async () => {
    fetchMock.mockReturnValueOnce(
      okJson({
        sales: [
          { serialNumber: 7, price: 42.5, soldAt: "2026-04-15T00:00:00Z", buyerUsername: "whale" },
        ],
      }),
    )
    const { getByText } = render(<EditionRecentSales editionKey="1:2" mintCount={100} />)
    await waitFor(() => expect(getByText("#7 / 100")).toBeTruthy()) // serial + mint
    expect(getByText("$42.50")).toBeTruthy()
    expect(getByText("→ whale")).toBeTruthy()
  })

  it("shows the no-sales state when the edition has none", async () => {
    fetchMock.mockReturnValueOnce(okJson({ sales: [] }))
    const { getByText } = render(<EditionRecentSales editionKey="1:2" />)
    await waitFor(() => expect(getByText("No recent sales")).toBeTruthy())
  })
})
