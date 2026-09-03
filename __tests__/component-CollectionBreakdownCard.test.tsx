// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import CollectionBreakdownCard from "@/components/profile/CollectionBreakdownCard"

// CollectionBreakdownCard fetches /api/profile/collection-breakdown, sums
// moment counts + FMV across rows, shows the FMV split bar only when total
// FMV is positive, and has distinct loading / empty / populated states.

let fetchMock: ReturnType<typeof vi.fn>
function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
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

describe("CollectionBreakdownCard", () => {
  it("shows the Loading… state before the fetch resolves", () => {
    fetchMock.mockReturnValue(new Promise(() => {})) // never resolves
    const { container } = render(<CollectionBreakdownCard ownerKey="0xabc" />)
    expect(container.textContent).toContain("Loading…")
  })

  it("renders the empty state when the API returns no collections", async () => {
    fetchMock.mockReturnValue(okJson({ collections: [] }))
    const { container } = render(<CollectionBreakdownCard ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("No collection data yet."))
  })

  it("sums moment counts, formats FMV per row, and renders the split bar when FMV > 0", async () => {
    fetchMock.mockReturnValue(
      okJson({
        collections: [
          { collection_id: "ts", collection_name: "NBA Top Shot", moment_count: 30, total_fmv: 1500, color: "#E03A2F" },
          { collection_id: "ad", collection_name: "NFL All Day", moment_count: 12, total_fmv: 500, color: "#4F94D4" },
        ],
      })
    )
    const { container } = render(<CollectionBreakdownCard ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("NBA Top Shot"))
    const txt = container.textContent!
    // totalMoments = 30 + 12 = 42
    expect(txt).toContain("42 moments")
    // fmtDollars: 1500 -> $1.5K, 500 -> $500.00
    expect(txt).toContain("$1.5K")
    expect(txt).toContain("$500.00")
    // Split bar segments carry a percent title; TS is 75% of $2000 FMV.
    const seg = container.querySelector('[title="NBA Top Shot 75.0%"]')
    expect(seg).not.toBeNull()
  })

  // The profile HEADLINE is total − stale (migration 20260903023012). Until
  // 2026-09-03 this card printed the RAW total per row, so a page read
  // "$48.0K" at the top and "NBA Top Shot $87.8K" one panel below it. The
  // row must show the same split as the headline, with the stale part as a
  // caption — and the raw total must NOT appear anywhere.
  it("renders total − stale per row with a stale caption, never the raw total", async () => {
    fetchMock.mockReturnValue(
      okJson({
        collections: [
          { collection_id: "ts", collection_name: "NBA Top Shot", moment_count: 100, total_fmv: 87800, stale_fmv: 43300, stale_count: 144, color: "#E03A2F" },
          { collection_id: "ad", collection_name: "NFL All Day", moment_count: 10, total_fmv: 500, stale_fmv: 0, stale_count: 0, color: "#4F94D4" },
        ],
      })
    )
    const { container } = render(<CollectionBreakdownCard ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("NBA Top Shot"))
    const txt = container.textContent!
    expect(txt).toContain("$44.5K") // 87800 − 43300
    expect(txt).not.toContain("$87.8K")
    const captions = container.querySelectorAll("[data-stale-caption]")
    expect(captions.length).toBe(1) // only the row that HAS a stale slice
    expect(captions[0].textContent).toContain("$43.3K")
    expect(captions[0].textContent).toContain("144")
    // The split bar is proportioned on LIVE value: 44,500 of 45,000 = 98.9%.
    expect(container.querySelector('[title="NBA Top Shot 98.9%"]')).not.toBeNull()
  })

  it("still shows the FMV column when everything is stale (live total 0)", async () => {
    fetchMock.mockReturnValue(
      okJson({
        collections: [
          { collection_id: "ufc", collection_name: "UFC Strike", moment_count: 247, total_fmv: 1310, stale_fmv: 1310, stale_count: 191, color: "#F59E0B" },
        ],
      })
    )
    const { container } = render(<CollectionBreakdownCard ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("UFC Strike"))
    expect(container.textContent).toContain("$0.00")
    expect(container.querySelector("[data-stale-caption]")?.textContent).toContain("$1.3K")
  })

  it("omits per-row FMV figures when total FMV is zero", async () => {
    fetchMock.mockReturnValue(
      okJson({
        collections: [
          { collection_id: "ts", collection_name: "NBA Top Shot", moment_count: 5, total_fmv: 0, color: "#E03A2F" },
        ],
      })
    )
    const { container } = render(<CollectionBreakdownCard ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("NBA Top Shot"))
    // No FMV bar and no $ figure when showFmv is false.
    expect(container.textContent).not.toContain("$")
    expect(container.textContent).toContain("5 moments")
  })
})
