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
