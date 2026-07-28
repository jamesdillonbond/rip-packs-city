// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"

import CollectionRecentSales from "@/components/collection/CollectionRecentSales"

// CollectionRecentSales owns the recentSales + salesLoading cluster extracted
// from the WalletMomentsBody monolith. Contract under test:
//   - renders nothing until a search has run (searchNonce 0) or when not visible
//   - the visibility gate is the inline original's: visible && (rows>0 || loading)
//   - re-fetches once per searchNonce bump
//   - a stale in-flight response never overwrites a newer one (the guard added
//     when the fetch moved from runSearch into an effect)

afterEach(cleanup)

const SALE = {
  playerName: "Nikola Jokic",
  setName: "Base Set",
  serialNumber: 412,
  price: 55,
  fmv: 50,
  soldAt: new Date(Date.now() - 30 * 60_000).toISOString(),
}

function mockFetchOnce(sales: any[]) {
  const fn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sales }) })
  vi.stubGlobal("fetch", fn)
  return fn
}

beforeEach(() => { vi.unstubAllGlobals() })

describe("CollectionRecentSales", () => {
  it("renders nothing and does not fetch before a search has run", () => {
    const f = mockFetchOnce([SALE])
    const { container } = render(<CollectionRecentSales searchNonce={0} visible={true} />)
    expect(container.innerHTML).toBe("")
    expect(f).not.toHaveBeenCalled()
  })

  it("fetches on the first nonce bump and renders the sale rows", async () => {
    const f = mockFetchOnce([SALE])
    render(<CollectionRecentSales searchNonce={1} visible={true} />)
    await waitFor(() => expect(screen.getByText("Nikola Jokic")).toBeTruthy())
    expect(f).toHaveBeenCalledWith("/api/recent-sales?limit=15")
    expect(screen.getByText("1 sales")).toBeTruthy()
    expect(screen.getByText("#412")).toBeTruthy()
    expect(screen.getByText("$55.00")).toBeTruthy()
    // (55 - 50) / 50 = +10%
    expect(screen.getByText("+10%")).toBeTruthy()
    expect(screen.getByText("30m ago")).toBeTruthy()
  })

  it("stays hidden when the parent has not flipped hasSearched, even with rows loaded", async () => {
    mockFetchOnce([SALE])
    const { container } = render(<CollectionRecentSales searchNonce={1} visible={false} />)
    await waitFor(() => expect((globalThis.fetch as any)).toHaveBeenCalled())
    expect(container.innerHTML).toBe("")
  })

  it("renders the loading state, then replaces it with the table", async () => {
    let resolve: (v: any) => void = () => {}
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((r) => { resolve = r })))
    render(<CollectionRecentSales searchNonce={1} visible={true} />)
    await waitFor(() => expect(screen.getByText("Loading sales history…")).toBeTruthy())
    resolve({ ok: true, json: async () => ({ sales: [SALE] }) })
    await waitFor(() => expect(screen.getByText("Nikola Jokic")).toBeTruthy())
    expect(screen.queryByText("Loading sales history…")).toBeNull()
  })

  it("re-fetches once per searchNonce bump", async () => {
    const f = mockFetchOnce([SALE])
    const { rerender } = render(<CollectionRecentSales searchNonce={1} visible={true} />)
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1))
    rerender(<CollectionRecentSales searchNonce={1} visible={true} />)
    expect(f).toHaveBeenCalledTimes(1) // same nonce → no refetch
    rerender(<CollectionRecentSales searchNonce={2} visible={true} />)
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2))
  })

  it("does not let a slow response from search N overwrite search N+1", async () => {
    const resolvers: Array<(v: any) => void> = []
    vi.stubGlobal("fetch", vi.fn().mockImplementation(
      () => new Promise((r) => { resolvers.push(r) })
    ))
    const { rerender } = render(<CollectionRecentSales searchNonce={1} visible={true} />)
    await waitFor(() => expect(resolvers.length).toBe(1))
    rerender(<CollectionRecentSales searchNonce={2} visible={true} />)
    await waitFor(() => expect(resolvers.length).toBe(2))

    // Second (current) search lands first, then the stale first search resolves.
    resolvers[1]({ ok: true, json: async () => ({ sales: [{ ...SALE, playerName: "CURRENT" }] }) })
    await waitFor(() => expect(screen.getByText("CURRENT")).toBeTruthy())
    resolvers[0]({ ok: true, json: async () => ({ sales: [{ ...SALE, playerName: "STALE" }] }) })
    await new Promise((r) => setTimeout(r, 20))

    expect(screen.queryByText("STALE")).toBeNull()
    expect(screen.getByText("CURRENT")).toBeTruthy()
  })

  it("survives a non-ok response and a rejected fetch without rendering a broken table", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
    const { container, rerender } = render(<CollectionRecentSales searchNonce={1} visible={true} />)
    await waitFor(() => expect(container.innerHTML).toBe(""))

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")))
    rerender(<CollectionRecentSales searchNonce={2} visible={true} />)
    await waitFor(() => expect(container.innerHTML).toBe(""))
  })

  it("formats a missing fmv as an em dash rather than a percentage", async () => {
    mockFetchOnce([{ ...SALE, fmv: null }])
    render(<CollectionRecentSales searchNonce={1} visible={true} />)
    await waitFor(() => expect(screen.getByText("Nikola Jokic")).toBeTruthy())
    expect(screen.queryByText("+10%")).toBeNull()
  })
})
