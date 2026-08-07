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
})
