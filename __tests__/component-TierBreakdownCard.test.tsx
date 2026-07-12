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

  it("does not fetch when ownerKey is empty", () => {
    render(<TierBreakdownCard ownerKey="" />)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
