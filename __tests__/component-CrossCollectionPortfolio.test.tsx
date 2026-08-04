// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import CrossCollectionPortfolio from "@/components/profile/CrossCollectionPortfolio"

// Drives the cross-collection portfolio card end-to-end: it fetches /api/portfolio,
// renders null until data arrives, then computes Total FMV / Moments / Collections /
// Total P&L (signed + colored) and a per-collection tile with fmtUsd money, a
// locked% and a supply bar. Money/P&L math is the regression surface.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))

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

const portfolio = {
  total_fmv: 12500,
  total_moments: 342,
  collection_count: 2,
  total_pnl: 3400,
  collections: [
    {
      collection_name: "NBA Top Shot",
      collection_slug: "nba-top-shot",
      total_moments: 300,
      wallet_fmv: 10000,
      locked_fmv: 2500, // 25% locked
      unlocked_fmv: 7500,
      locked_count: 10,
      unlocked_count: 20,
      cost_basis: 8000,
      pnl: 2000,
    },
    {
      collection_name: "NFL All Day",
      collection_slug: "nfl-all-day",
      total_moments: 42,
      wallet_fmv: 42.5,
      locked_fmv: 0,
      unlocked_fmv: 42.5,
      locked_count: 0,
      unlocked_count: 42,
      cost_basis: null,
      pnl: null,
    },
  ],
}

describe("CrossCollectionPortfolio", () => {
  it("renders nothing before data resolves", () => {
    fetchMock.mockReturnValue(new Promise(() => {})) // never resolves
    const { container } = render(<CrossCollectionPortfolio wallet="0xabc" walletQuery="damian" />)
    expect(container.firstChild).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/portfolio?wallet=0xabc"))
  })

  it("renders nothing when the response has no collections", async () => {
    fetchMock.mockReturnValue(okJson({ total_fmv: 0, collections: [] }))
    const { container } = render(<CrossCollectionPortfolio wallet="0xabc" walletQuery="x" />)
    // give the effect a tick; still null
    await Promise.resolve()
    expect(container.firstChild).toBeNull()
  })

  it("computes the summary stats and formats big-dollar FMV with commas", async () => {
    fetchMock.mockReturnValue(okJson(portfolio))
    const { container } = render(<CrossCollectionPortfolio wallet="0xabc" walletQuery="damian" />)
    await waitFor(() => expect(container.textContent).toContain("Cross-Collection Portfolio"))
    const txt = container.textContent!
    expect(txt).toContain("$12,500") // total_fmv >= 1000 -> rounded w/ commas
    expect(txt).toContain("342")     // total moments
    expect(txt).toContain("+$3,400") // positive P&L gets a + sign
  })

  it("renders a positive P&L green and a negative P&L red", async () => {
    fetchMock.mockReturnValue(okJson({ ...portfolio, total_pnl: -500 }))
    const { container } = render(<CrossCollectionPortfolio wallet="0xabc" walletQuery="x" />)
    await waitFor(() => expect(container.textContent).toContain("Total P&L"))
    // negative -> no + sign; the minus goes BEFORE the $ ("-$500.00"), never "$-500.00".
    expect(container.innerHTML).toContain("rgb(239, 68, 68)") // red
    expect(container.textContent).toContain("-$500.00")
    expect(container.textContent).not.toContain("$-500.00")
  })

  it("places the minus before the $ on a big (>= $1k) negative P&L", async () => {
    fetchMock.mockReturnValue(okJson({ ...portfolio, total_pnl: -1500 }))
    const { container } = render(<CrossCollectionPortfolio wallet="0xabc" walletQuery="x" />)
    await waitFor(() => expect(container.textContent).toContain("Total P&L"))
    expect(container.textContent).toContain("-$1,500")   // not "$-1,500"
    expect(container.textContent).not.toContain("$-1,500")
  })

  it("shows a — P&L when total_pnl is null", async () => {
    fetchMock.mockReturnValue(okJson({ ...portfolio, total_pnl: null }))
    const { container } = render(<CrossCollectionPortfolio wallet="0xabc" walletQuery="x" />)
    await waitFor(() => expect(container.textContent).toContain("Total P&L"))
    // The P&L stat value is a bare — (grid also has other stats)
    expect(container.textContent).toContain("—")
  })

  it("renders per-collection tiles with small-dollar cents, moment counts and locked%", async () => {
    fetchMock.mockReturnValue(okJson(portfolio))
    const { container } = render(<CrossCollectionPortfolio wallet="0xabc" walletQuery="x" />)
    await waitFor(() => expect(container.textContent).toContain("NBA Top Shot"))
    const txt = container.textContent!
    expect(txt).toContain("$42.50")     // NFL fmv < 1000 -> cents
    expect(txt).toContain("25% locked") // 2500/10000
    expect(txt).toContain("0% locked")  // NFL has locked_fmv 0
    expect(txt).toContain("NFL All Day")
  })

  it("renders a closed-market collection as a count + closure note, not a dollar, and shows a disclosure line", async () => {
    const withClosed = {
      ...portfolio,
      collections: [
        ...portfolio.collections,
        {
          collection_name: "UFC Strike",
          collection_slug: "ufc-strike",
          market_closed_at: "2026-05-13T00:00:00+00:00",
          total_moments: 276,
          wallet_fmv: 3734.98, // still numeric in the payload, but must NOT render
          locked_fmv: 0,
          unlocked_fmv: 3734.98,
          locked_count: 0,
          unlocked_count: 276,
          cost_basis: 128,
          pnl: -76,
        },
      ],
    }
    fetchMock.mockReturnValue(okJson(withClosed))
    const { container } = render(<CrossCollectionPortfolio wallet="0xabc" walletQuery="x" />)
    await waitFor(() => expect(container.textContent).toContain("UFC Strike"))
    const txt = container.textContent!
    expect(txt).toContain("276 moments")
    expect(txt).toContain("market closed")       // card body, not a dollar
    expect(txt).toContain("excluded from Total FMV") // disclosure line names the reason
    expect(txt).not.toContain("$3,735")          // dead-market value never rendered
    expect(txt).not.toContain("$3,734")
  })
})
