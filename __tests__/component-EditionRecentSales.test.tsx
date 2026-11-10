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
    const { getByText } = render(<EditionRecentSales collectionSlug="nba-top-shot" editionKey={null} />)
    expect(getByText("Recent Sales")).toBeTruthy()
    expect(getByText("—")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows the loading placeholder before data arrives", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {})) // never resolves
    const { getByText } = render(<EditionRecentSales collectionSlug="nba-top-shot" editionKey="1:2" />)
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
    const { getByText } = render(<EditionRecentSales collectionSlug="nba-top-shot" editionKey="1:2" mintCount={100} />)
    await waitFor(() => expect(getByText("#7 / 100")).toBeTruthy()) // serial + mint
    expect(getByText("$42.50")).toBeTruthy()
    expect(getByText("→ whale")).toBeTruthy()
  })

  it("shows the no-sales state when the edition has none", async () => {
    fetchMock.mockReturnValueOnce(okJson({ sales: [] }))
    const { getByText } = render(<EditionRecentSales collectionSlug="nba-top-shot" editionKey="1:2" />)
    await waitFor(() => expect(getByText("No recent sales")).toBeTruthy())
  })

  it("⚠ asks for the row's OWN collection — a bare editionKey is looked up as Top Shot and reads 'No recent sales'", async () => {
    // 2026-11-10, measured live: an All Day edition with 5 sales that hour answered 0 without collectionId.
    fetchMock.mockReturnValueOnce(okJson({ sales: [] }))
    render(<EditionRecentSales collectionSlug="nfl-all-day" editionKey="4461" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(String(fetchMock.mock.calls[0][0])).toContain("collectionId=nfl-all-day")
  })

  it("⚠ does NOT conclude 'No recent sales' for an edition the route could not find", async () => {
    fetchMock.mockReturnValueOnce(okJson({ sales: [], editionKnown: false }))
    const { getByText, queryByText } = render(<EditionRecentSales collectionSlug="disney-pinnacle" editionKey="render-1" />)
    await waitFor(() => expect(getByText("—")).toBeTruthy())
    expect(queryByText("No recent sales")).toBeNull()
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
      <EditionRecentSales collectionSlug="nba-top-shot" editionKey="1:AAAA" mintCount={100} />,
    )
    rerender(<EditionRecentSales collectionSlug="nba-top-shot" editionKey="1:BBBB" mintCount={100} />)
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
