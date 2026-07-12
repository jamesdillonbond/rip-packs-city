// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import CostBasisCard from "@/components/profile/CostBasisCard"

// CostBasisCard is privacy-gated: it renders nothing (and never fetches)
// unless ownView is true. When shown it maps the cost-basis summary into
// Total Spent / Current FMV / Net P/L, colors + signs the P/L, and has
// distinct zero-spend and error states.

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

describe("CostBasisCard", () => {
  it("renders nothing and never fetches for a non-owner view", () => {
    const { container } = render(<CostBasisCard ownerKey="0xabc" />)
    expect(container.firstChild).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("renders a positive P/L with a + sign and percent when spend exists", async () => {
    fetchMock.mockReturnValue(
      okJson({ totalSpent: 1000, totalPurchases: 4, totalFmv: 1600, netPL: 600, plPercent: 60 })
    )
    const { container } = render(<CostBasisCard ownerKey="0xabc" ownView />)
    await waitFor(() => expect(container.textContent).toContain("Net P/L"))
    const txt = container.textContent!
    expect(txt).toContain("4 purchases")
    expect(txt).toContain("$1.0K") // total spent
    expect(txt).toContain("$1.6K") // current fmv
    expect(txt).toContain("+$600.00")
    expect(txt).toContain("+60.0%")
  })

  it("uses the − sign for a negative P/L", async () => {
    fetchMock.mockReturnValue(
      okJson({ totalSpent: 1000, totalPurchases: 2, totalFmv: 400, netPL: -600, plPercent: -60 })
    )
    const { container } = render(<CostBasisCard ownerKey="0xabc" ownView />)
    await waitFor(() => expect(container.textContent).toContain("Net P/L"))
    expect(container.textContent).toContain("−$600.00")
    expect(container.textContent).toContain("−60.0%")
  })

  it("shows the no-purchase-data state when totalSpent is 0", async () => {
    fetchMock.mockReturnValue(
      okJson({ totalSpent: 0, totalPurchases: 0, totalFmv: 0, netPL: 0, plPercent: null })
    )
    const { container } = render(<CostBasisCard ownerKey="0xabc" ownView />)
    await waitFor(() => expect(container.textContent).toContain("No purchase data yet"))
    expect(container.textContent).not.toContain("Net P/L")
  })

  it("shows the unavailable state when the API returns a malformed body", async () => {
    fetchMock.mockReturnValue(okJson({ oops: true }))
    const { container } = render(<CostBasisCard ownerKey="0xabc" ownView />)
    await waitFor(() => expect(container.textContent).toContain("Cost basis unavailable."))
  })
})
