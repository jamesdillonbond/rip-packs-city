// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// components/analytics/CostBasisCard (0% before this; distinct from the tested
// components/profile/CostBasisCard). Fetches /api/wallet-cost-basis and renders
// the P&L card ONLY when a tracked summary exists — null on a missing response,
// an error/reason payload, or zero tracked moments. Drives both the null-guards
// and the populated render.

import CostBasisCard from "@/components/analytics/CostBasisCard"

function stub(payload: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok, json: async () => payload } as Response)))
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const summary = {
  summary: {
    tracked_count: 12,
    total_cost_basis: 1000,
    total_current_fmv: 1340,
    total_pnl_usd: 340,
    total_pnl_pct: 34,
    win_count: 8,
    loss_count: 4,
  },
  sample_size_note: "Based on 12 tracked moments",
  top_movers: { gainers: [], losers: [] },
}

describe("CostBasisCard (analytics)", () => {
  it("renders the P&L card when a tracked summary exists", async () => {
    stub(summary)
    const { findAllByText } = render(<CostBasisCard wallet="0xabc" urlSlug="nba-top-shot" />)
    expect((await findAllByText(/Cost Basis/i)).length).toBeGreaterThan(0)
  })

  it("renders nothing when the cost-basis endpoint errors", async () => {
    stub(null, false)
    const { container } = render(<CostBasisCard wallet="0xabc" urlSlug="nba-top-shot" />)
    await waitFor(() => expect((fetch as any).mock.calls.length).toBeGreaterThan(0))
    expect(container.textContent).toBe("")
  })

  it("renders nothing when zero moments are tracked", async () => {
    stub({ summary: { tracked_count: 0 } })
    const { container } = render(<CostBasisCard wallet="0xabc" urlSlug="nba-top-shot" />)
    await waitFor(() => expect((fetch as any).mock.calls.length).toBeGreaterThan(0))
    expect(container.textContent).toBe("")
  })
})
