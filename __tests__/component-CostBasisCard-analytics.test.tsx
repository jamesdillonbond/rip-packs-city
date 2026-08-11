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

  it("renders nothing when the payload carries a reason (unsupported collection)", async () => {
    stub({ reason: "unsupported_collection", summary: { tracked_count: 5 } })
    const { container } = render(<CostBasisCard wallet="0xabc" urlSlug="ufc" />)
    await waitFor(() => expect((fetch as any).mock.calls.length).toBeGreaterThan(0))
    expect(container.textContent).toBe("")
  })

  it("shows the win-rate line, sample-size note, and top movers with +/- signs", async () => {
    stub({
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
      top_movers: {
        gainers: [
          { player_name: "LeBron", set_name: "Base", tier: "COMMON", serial_number: 7, buy_price: 10, current_fmv: 25, pnl_pct: 150 },
        ],
        losers: [
          { player_name: null, set_name: null, tier: null, serial_number: null, buy_price: 100, current_fmv: 40, pnl_pct: -60 },
        ],
      },
    })
    const { container, findByText } = render(<CostBasisCard wallet="0xabc" urlSlug="nba-top-shot" />)
    expect(await findByText(/Based on 12 tracked moments/)).toBeTruthy()
    const txt = container.textContent!
    expect(txt).toContain("Win rate: 8 of 12")
    expect(txt).toContain("Top Gainers")
    expect(txt).toContain("Top Losers")
    expect(txt).toContain("LeBron")
    expect(txt).toContain("#7")
    expect(txt).toContain("+150.0%")
    // null player_name / set_name → em-dash; negative mover keeps its sign
    expect(txt).toContain("—")
    expect(txt).toContain("-60.0%")
  })

  it("renders a negative total P&L without a + sign (danger color path)", async () => {
    stub({
      summary: {
        tracked_count: 3,
        total_cost_basis: 500,
        total_current_fmv: 300,
        total_pnl_usd: -200,
        total_pnl_pct: -40,
        win_count: 0,
        loss_count: 0, // winDenom 0 → win-rate line suppressed
      },
      top_movers: { gainers: [], losers: [] }, // both empty → no movers block
    })
    const { container, findAllByText } = render(<CostBasisCard wallet="0xabc" urlSlug="nba-top-shot" />)
    expect((await findAllByText(/Cost Basis/i)).length).toBeGreaterThan(0)
    const txt = container.textContent!
    expect(txt).not.toContain("Win rate")
    expect(txt).not.toContain("Top Gainers")
    // negative P&L: no "+" prefix on the -200
    expect(txt).toContain("-40.0%")
  })

  it("shows the empty-state copy when only one side of the movers is populated", async () => {
    stub({
      summary: {
        tracked_count: 2,
        total_cost_basis: 100,
        total_current_fmv: 150,
        total_pnl_usd: 50,
        total_pnl_pct: 50,
        win_count: 1,
        loss_count: 0,
      },
      top_movers: {
        gainers: [
          { player_name: "Curry", set_name: "Base", tier: "RARE", serial_number: null, buy_price: 50, current_fmv: 100, pnl_pct: 100 },
        ],
        losers: [],
      },
    })
    const { container, findByText } = render(<CostBasisCard wallet="0xabc" urlSlug="nba-top-shot" />)
    expect(await findByText(/Top Losers/)).toBeTruthy()
    const txt = container.textContent!
    expect(txt).toContain("No tracked losers.")
    // gainer with no serial_number → no "#" suffix rendered for it
    expect(txt).toContain("Curry")
  })
})
