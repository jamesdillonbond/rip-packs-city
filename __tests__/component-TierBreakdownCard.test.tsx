// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import TierBreakdownCard from "@/components/profile/TierBreakdownCard"

// TierBreakdownCard fetches /api/profile/tier-breakdown, and on data renders a
// proportional stacked bar plus a legend where each tier shows its count and
// its share of the total as a 1-dp percent. total === 0 => empty prompt.

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

describe("TierBreakdownCard", () => {
  it("shows the empty prompt when the total is zero", async () => {
    fetchMock.mockReturnValue(okJson({ tiers: [], total: 0 }))
    const { container } = render(<TierBreakdownCard ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("Load a saved wallet to see your tier mix."))
  })

  it("renders per-tier count, total caption, and 1-dp share percentages", async () => {
    fetchMock.mockReturnValue(
      okJson({
        tiers: [
          { tier: "Common", count: 75 },
          { tier: "Rare", count: 25 },
        ],
        total: 100,
      })
    )
    const { container } = render(<TierBreakdownCard ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("Common"))
    const txt = container.textContent!
    expect(txt).toContain("100 moments")
    expect(txt).toContain("75.0%")
    expect(txt).toContain("25.0%")
    // Stacked-bar segment carries a "tier · count" title (uses real tier color).
    expect(container.querySelector('[title="Common · 75"]')).not.toBeNull()
  })

  // HONESTY CANON. This card had NO failure state: `r.ok ? r.json() : null`
  // then `if (d && ...)` left `data` null on a 5xx, on a network error AND on a
  // genuine empty, and `total === 0` renders "Load a saved wallet to see your
  // tier mix." — a claim about the reader's own account, of the ACTIONABLE kind
  // that tells a collector to redo work already done. The first case in this
  // file is the genuine-empty positive control; these two are the failures it
  // must no longer be confused with.
  it("does not tell the reader to load a wallet when the read 5xx'd", async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response)
    )
    const { container } = render(<TierBreakdownCard ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("Couldn't load your tier mix right now."))
    expect(container.textContent).not.toContain("Load a saved wallet")
  })

  it("does not tell the reader to load a wallet when the fetch rejected", async () => {
    fetchMock.mockReturnValue(Promise.reject(new Error("network down")))
    const { container } = render(<TierBreakdownCard ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("Couldn't load your tier mix right now."))
    expect(container.textContent).not.toContain("Load a saved wallet")
  })

  it("does not publish a moment count it could not read", async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response)
    )
    const { container } = render(<TierBreakdownCard ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("Couldn't load"))
    expect(container.textContent).not.toContain("moments")
  })

  it("does not fetch when ownerKey is empty", () => {
    render(<TierBreakdownCard ownerKey="" />)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
