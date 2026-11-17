// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import type React from "react"
import { render, cleanup, waitFor } from "@testing-library/react"

vi.mock("@/components/MomentMedia", () => ({ default: () => null }))

import CandyPackMarket from "@/components/packs/CandyPackMarket"

function payload(over: Record<string, unknown> = {}) {
  return {
    product: { name: "2026 MLB Base Series ICONs", imageUrl: null, retailUsd: 10, declaredSupply: 2500 },
    supply: { indexed: 2501, duplicateSerials: 1, treasuryHeld: 2336, collectorHeld: 165, collectorWallets: 63, burnt: 0, refreshedAt: "2026-09-26T01:00:00Z" },
    market: {
      confirmedFloorUsd: 36.44, confirmedFloorSol: 0.3, confirmedAsks: 13, unconfirmedAsks: 10, confirmedWithinHours: 12,
      salesAll: 465, sales7d: 0, median7dUsd: null, lastSaleAt: "2026-09-14T19:52:44Z", lastSaleUsd: 51.78,
    },
    ev: { iconSlots: 10, rainbowChance: 0.15, packCostUsd: 10, typicalPullUsd: 11.6, actualEvUsd: 44.83, rainbowPriced: 25, rainbowTotal: 25, commonPriced: 100, commonTotal: 100, note: null },
    ev_error: false,
    asks: [
      { priceUsd: 36.44, priceSol: 0.3, lastSeenAt: "2026-09-26T00:36:00Z", confirmed: true },
      { priceUsd: 30.02, priceSol: 0.25, lastSeenAt: "2026-09-21T15:35:00Z", confirmed: false },
    ],
    asks_error: false,
    sales: [{ serial: 606, priceUsd: 51.78, priceSol: 0.4, marketplace: "magic_eden", soldAt: "2026-09-14T19:52:44Z" }],
    sales_error: false,
    owned: null,
    owned_error: null,
    ...over,
  }
}

function mockFetch(status: number, json: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => json })))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function mount(): Promise<HTMLElement> {
  const { container } = render(<CandyPackMarket />)
  await waitFor(() => expect(container.textContent).not.toBe(""))
  await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull())
  return container
}

describe("CandyPackMarket", () => {
  it("leads with the CONFIRMED floor and labels the unconfirmed ask", async () => {
    mockFetch(200, payload())
    const c = await mount()
    const text = c.textContent ?? ""
    expect(text).toContain("Lowest confirmed ask")
    expect(text).toContain("$36.44")
    expect(text).toContain("unconfirmed")
    // The median tile does not invent a 7-day price out of zero sales.
    expect(text).toContain("no pack sales in 7 days")
  })

  it("a failed asks read says it failed, never 'no asks'", async () => {
    mockFetch(200, payload({ asks: null, asks_error: true, market: { ...payload().market, confirmedAsks: null, unconfirmedAsks: null, confirmedFloorUsd: null } }))
    const c = await mount()
    const text = c.textContent ?? ""
    expect(text).toContain("Asks couldn't load")
    expect(text).not.toContain("No active pack asks")
  })

  it("a failed route renders an error, never a zeroed board", async () => {
    mockFetch(503, { error: "Pack market is unavailable right now." })
    const c = await mount()
    const text = c.textContent ?? ""
    expect(text).toContain("Couldn't load packs")
    expect(text).not.toContain("$0.00")
  })
})
