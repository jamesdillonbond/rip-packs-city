// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor, fireEvent, screen } from "@testing-library/react"

vi.mock("@/components/analytics/KpiCard", () => ({ default: () => null }))

import ListingsDashboard from "@/components/analytics/ListingsDashboard"

// Drives ListingsDashboard's fetch orchestration (summary + loan-offers) and its
// soft-fail leg. Note the offers endpoint returns {rows:[]} — the component's own
// comment flags that `?? []` only catches null/undefined, so a bare {} would
// throw on .map; the fixture returns the safe shape.
function routeFetch() {
  return vi.fn(async (url: string) => {
    const u = String(url)
    const body = u.includes("/listings/summary")
      ? { collections: {}, rows: [] }
      : { rows: [] } // loan-offers
    return { ok: true, json: async () => body } as any
  })
}

let fetchMock: ReturnType<typeof routeFetch>
beforeEach(() => {
  fetchMock = routeFetch()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("ListingsDashboard", () => {
  it("fires the summary + loan-offers endpoints on mount", async () => {
    render(<ListingsDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes("/listings/summary"))).toBe(true)
    expect(urls.some((u) => u.includes("/listings/loan-offers"))).toBe(true)
  })

  it("renders without crashing on empty responses", async () => {
    expect(() => render(<ListingsDashboard />)).not.toThrow()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it("soft-fails on a rejected fetch", async () => {
    fetchMock.mockRejectedValue(new Error("network"))
    expect(() => render(<ListingsDashboard />)).not.toThrow()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it("closes the sort dropdown on Escape (keyboard dismissal)", async () => {
    render(<ListingsDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // "Lowest APR" is a dropdown option only present once the sort menu opens.
    expect(screen.queryByText("Lowest APR")).toBeNull()
    fireEvent.click(screen.getByText("Sort"))
    expect(screen.getByText("Lowest APR")).toBeTruthy()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByText("Lowest APR")).toBeNull()
  })

  it("closes the sort dropdown on an outside click", async () => {
    render(<ListingsDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    fireEvent.click(screen.getByText("Sort"))
    expect(screen.getByText("Lowest APR")).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText("Lowest APR")).toBeNull()
  })

  it("renders offer rows, marketplace rows, and the sparse badge on populated data", async () => {
    const populated = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes("/listings/summary")) {
        const body = {
          as_of: "2026-08-01T00:00:00Z",
          loan_offers: {
            count: 3,
            total_principal_usd: 900,
            avg_principal_usd: 300,
            avg_apr: 0.12,
            avg_term_days: 30,
          },
          topshot_orderbook: {
            count: 120,
            min_ask_usd: 2,
            median_ask_usd: 5,
            p90_ask_usd: 40,
            max_ask_usd: 500,
            avg_ask_usd: 20,
            total_ask_usd: 2400,
            locked_count: 4,
          },
          marketplace_listings: [
            { collection: "topshot", count: 150, min_ask_usd: 2, max_ask_usd: 500, avg_ask_usd: 20, median_ask_usd: 8 },
            { collection: "ufc", count: 5, min_ask_usd: 1, max_ask_usd: 9, avg_ask_usd: 4, median_ask_usd: 3 },
          ],
          data_caveats: ["Sniper feed is low-price biased."],
        }
        return { ok: true, json: async () => body } as any
      }
      // loan-offers endpoint — three rows exercising the borrower display branches.
      const body = {
        sort: "apr_desc",
        rows: [
          {
            listing_resource_id: "L1",
            collection: "topshot",
            borrower_addr: "0x1234567890abcdef",
            storefront_address: "0x1111111111111111",
            borrower_inferred: false,
            principal_usd: 100,
            principal_currency: "USD",
            interest_rate: 0.1,
            apr_pct: 12,
            term_days: 30,
            expires_at: null,
            listed_at: "2026-07-31T00:00:00Z",
            nft_id: "999",
          },
          {
            listing_resource_id: "L2",
            collection: "allday",
            borrower_addr: "0xabcdef1234567890",
            storefront_address: "0x2222222222222222",
            borrower_inferred: true,
            principal_usd: 200,
            principal_currency: "USD",
            interest_rate: null,
            apr_pct: null,
            term_days: null,
            expires_at: null,
            listed_at: null,
            nft_id: null,
          },
          {
            listing_resource_id: "L3",
            collection: "golazos",
            borrower_addr: null,
            storefront_address: "0x3333333333333333",
            borrower_inferred: false,
            principal_usd: 50,
            principal_currency: "USD",
            interest_rate: 0.2,
            apr_pct: 20,
            term_days: 14,
            expires_at: null,
            listed_at: "2026-07-30T00:00:00Z",
            nft_id: "42",
          },
        ],
      }
      return { ok: true, json: async () => body } as any
    })
    vi.stubGlobal("fetch", populated)
    render(<ListingsDashboard />)
    // A linkable borrower row + the null-borrower "via <storefront>" fallback.
    await waitFor(() => expect(screen.getAllByText(/via 0x/i).length).toBeGreaterThan(0))
    // Marketplace: the ufc row (count 5 < 30) shows the Sparse badge.
    expect(screen.getByText("Sparse")).toBeTruthy()
  })

  it("expands the data-caveats section when toggled", async () => {
    const withCaveats = vi.fn(async (url: string) => {
      const u = String(url)
      const body = u.includes("/listings/summary")
        ? {
            as_of: "2026-08-01T00:00:00Z",
            loan_offers: { count: 0, total_principal_usd: 0, avg_principal_usd: null, avg_apr: null, avg_term_days: null },
            topshot_orderbook: { count: 0, min_ask_usd: null, median_ask_usd: null, p90_ask_usd: null, max_ask_usd: null, avg_ask_usd: null, total_ask_usd: null, locked_count: 0 },
            marketplace_listings: [],
            data_caveats: ["Caveat one line."],
          }
        : { rows: [], sort: "apr_desc" }
      return { ok: true, json: async () => body } as any
    })
    vi.stubGlobal("fetch", withCaveats)
    render(<ListingsDashboard />)
    await waitFor(() => expect(screen.getByText("About this data")).toBeTruthy())
    expect(screen.queryByText("Caveat one line.")).toBeNull()
    fireEvent.click(screen.getByText("About this data"))
    expect(screen.getByText("Caveat one line.")).toBeTruthy()
  })

  it("refetches when a collection chip is toggled and when the sort changes", async () => {
    render(<ListingsDashboard />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole("button", { name: "Top Shot" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("collections=topshot"))).toBe(true)
    // Change the sort via the dropdown → another summary+offers pair.
    fireEvent.click(screen.getByText("Sort"))
    fireEvent.click(screen.getByText("Lowest APR"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6))
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("sort=apr_asc"))).toBe(true)
  })
})
