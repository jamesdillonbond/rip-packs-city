// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor, screen } from "@testing-library/react"
import BuybackDashboard from "@/components/analytics/BuybackDashboard"

// Render tests for the buyback board.
//
// These assert the ABSENCE of the false claim rather than the presence of a
// caveat — the distinction CLAUDE.md records from the pack-reality case, where
// a test asserted an error string appeared *somewhere on the page* and passed
// for years while three market claims rendered directly beneath it.

let fetchMock: ReturnType<typeof vi.fn>

function jsonResp(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)
}

const payload = {
  period: "all",
  window_start: "2026-06-09",
  window_end: "2026-08-16",
  basis: "verified_marketplace_purchases",
  totals: {
    purchases: 431,
    priced_purchases: 431,
    spend_usd: 10081.93,
    spend_known: true,
    distinct_editions: 138,
    active_days: 48,
  },
  coverage: {
    observation_start: "2026-06-09",
    unpriced_purchases: 0,
    counterparty_known_for: 431,
    date_grain: "day",
    excluded_snapshot_rows: 161366,
    excluded_wallets: 1,
    excluded_reason: "41,301 of 41,307 distinct moments were already held on the first snapshot",
  },
  wallets: [
    {
      address: "0xe1f2a091f7bb5245",
      username: "TopShot_Buyback_2",
      purchases: 431,
      priced_acquisitions: 431,
      spend_usd: 10081.93,
      distinct_editions: 138,
      spend_known: true,
    },
    {
      address: "0x4d2c9216f1dca098",
      username: "NBATopShotCommunity",
      purchases: 12,
      priced_acquisitions: 0,
      spend_usd: null,
      distinct_editions: 9,
      spend_known: false,
    },
  ],
  top_editions_by_count: [
    {
      edition_id: "e1",
      player_name: "Grant Williams",
      set_name: "Base Set",
      tier: "COMMON",
      purchases: 14,
      priced_acquisitions: 14,
      spend_usd: 86.91,
    },
  ],
  top_editions_by_spend: [
    {
      edition_id: "e2",
      player_name: "Jalen Brunson",
      set_name: "2026 NBA Finals",
      tier: "LEGENDARY",
      priced_acquisitions: 1,
      spend_usd: 622,
    },
  ],
  top_sellers_by_spend: [
    { seller_address: "0xd4d19490bd4f4c4d", username: "Anderson_Pack", purchases: 7, spend_usd: 938.39 },
  ],
  top_sellers_by_count: [
    { seller_address: "0x3691693414f2daba", username: "jiggydigital", purchases: 14, spend_usd: 86.91 },
  ],
  timeline: [{ d: "2026-08-16", purchases: 5, priced_acquisitions: 5, spend_usd: 120.5 }],
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  // vitest.components.config.ts does not enable globals, so testing-library's
  // auto-cleanup never registers — without this the previous tree stays mounted.
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("BuybackDashboard", () => {
  it("renders the unpriced wallet WITHOUT claiming it spent $0", async () => {
    fetchMock.mockReturnValue(jsonResp(payload))
    const { container } = render(<BuybackDashboard />)
    await waitFor(() => expect(screen.getByText("NBATopShotCommunity")).toBeTruthy())

    // The priced wallet's real figure is shown.
    expect(container.textContent).toContain("$10.1k")
    // The unpriced wallet is explained, not zeroed.
    expect(container.textContent).toMatch(/no price recorded on-chain/i)
    // THE ASSERTION THAT MATTERS: a "$0" for the 161,366 unpriced acquisitions
    // must appear nowhere on the page.
    expect(container.textContent).not.toMatch(/\$0(\.00)?\b/)
  })

  it("discloses the excluded artifact rows, so a small board is not read as inactivity", async () => {
    fetchMock.mockReturnValue(jsonResp(payload))
    const { container } = render(<BuybackDashboard />)
    await waitFor(() =>
      expect(container.textContent).toMatch(/excluded as unreliable/i)
    )
    // The count makes the omission auditable rather than merely asserted.
    expect(container.textContent).toContain("161,366")
    expect(container.textContent).toContain("41,301")
  })

  it("qualifies the all-time window as all TRACKED time", async () => {
    fetchMock.mockReturnValue(jsonResp(payload))
    const { container } = render(<BuybackDashboard />)
    await waitFor(() => expect(container.textContent).toMatch(/all\s+tracked\s+time/i))
    expect(container.textContent).toContain("2026-06-09")
  })

  it("scopes the seller leaderboards to priced purchases", async () => {
    fetchMock.mockReturnValue(jsonResp(payload))
    const { container } = render(<BuybackDashboard />)
    await waitFor(() => expect(screen.getByText("Anderson_Pack")).toBeTruthy())
    // "who they buy from" is unanswerable for direct transfers, and the panel
    // must say which subset it describes.
    expect(container.textContent).toMatch(/Priced marketplace purchases only/i)
    expect(container.textContent).toMatch(/Direct transfers record no counterparty/i)
  })

  it("renders the verified-purchase leaderboard", async () => {
    fetchMock.mockReturnValue(jsonResp(payload))
    const { container } = render(<BuybackDashboard />)
    await waitFor(() => expect(screen.getByText(/Grant Williams/)).toBeTruthy())
    expect(container.textContent).toContain("14")
  })

  it("a failed read says so and does NOT render an empty-board claim", async () => {
    fetchMock.mockReturnValue(jsonResp(null, false))
    const { container } = render(<BuybackDashboard />)
    await waitFor(() =>
      expect(container.textContent).toMatch(/could not be loaded/i)
    )
    // It must explicitly disclaim the market reading...
    expect(container.textContent).toMatch(/not a report that the buyback wallets were inactive/i)
    // ...and none of the "no activity" copy may render alongside it.
    expect(container.textContent).not.toMatch(/No verified buyback purchases/i)
    expect(container.textContent).not.toMatch(/No priced purchases/i)
    expect(container.textContent).not.toMatch(/excluded as unreliable/i)
  })

  it("a thrown fetch is handled the same as a 5xx", async () => {
    fetchMock.mockReturnValue(Promise.reject(new Error("network down")))
    const { container } = render(<BuybackDashboard />)
    await waitFor(() => expect(container.textContent).toMatch(/could not be loaded/i))
    expect(container.textContent).not.toMatch(/No verified buyback purchases/i)
  })

  it("a genuinely empty window reads as an honest zero, not as a failure", async () => {
    fetchMock.mockReturnValue(
      jsonResp({
        ...payload,
        period: "week",
        totals: {
          purchases: 0,
          priced_purchases: 0,
          spend_usd: 0,
          spend_known: false,
          distinct_editions: 0,
          active_days: 0,
        },
        coverage: { ...payload.coverage, unpriced_purchases: 0, excluded_snapshot_rows: 0 },
        wallets: [],
        top_editions_by_count: [],
        top_editions_by_spend: [],
        top_sellers_by_spend: [],
        top_sellers_by_count: [],
      })
    )
    const { container } = render(<BuybackDashboard />)
    await waitFor(() =>
      expect(container.textContent).toMatch(/No verified buyback purchases/i)
    )
    // The failure banner must NOT appear for a real empty result...
    expect(container.textContent).not.toMatch(/could not be loaded/i)
    // ...and both caveats are suppressed when there is nothing to caveat, rather
    // than crying wolf on a complete (if empty) answer.
    expect(container.textContent).not.toMatch(/Spend is known for/i)
    expect(container.textContent).not.toMatch(/excluded as unreliable/i)
  })

  it("always states the window it is describing", async () => {
    fetchMock.mockReturnValue(jsonResp(payload))
    const { container } = render(<BuybackDashboard />)
    await waitFor(() => expect(container.textContent).toMatch(/Window:/))
    expect(container.textContent).toContain("2026-08-16")
  })
})
