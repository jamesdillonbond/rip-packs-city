// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, act } from "@testing-library/react"
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

  it("ignores a stale response when editionKey changes mid-flight", async () => {
    // First edition's fetch resolves LAST; the newer edition's resolves first.
    let resolveStale!: (r: Response) => void
    const slow = new Promise<Response>((res) => { resolveStale = res })
    fetchMock
      .mockReturnValueOnce(slow) // editionKey A — in flight, resolves last
      .mockReturnValueOnce(
        okJson({ sales: [{ serialNumber: 222, price: 2, soldAt: "2026-04-15T00:00:00Z" }] }),
      ) // editionKey B — resolves immediately
    const { rerender, getByText, queryByText } = render(
      <EditionRecentSales editionKey="1:AAAA" mintCount={100} />,
    )
    rerender(<EditionRecentSales editionKey="1:BBBB" mintCount={100} />)
    await waitFor(() => expect(getByText("#222 / 100")).toBeTruthy()) // newer data painted

    // The stale (first) response now lands — it must NOT overwrite the newer edition.
    await act(async () => {
      resolveStale({
        ok: true,
        json: () => Promise.resolve({ sales: [{ serialNumber: 111, price: 1, soldAt: "2026-04-15T00:00:00Z" }] }),
      } as Response)
      await Promise.resolve()
    })
    expect(queryByText("#111 / 100")).toBeNull()   // stale response ignored
    expect(getByText("#222 / 100")).toBeTruthy()   // newer data still shown
  })
})
