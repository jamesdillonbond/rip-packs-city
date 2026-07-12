import { describe, it, expect } from "vitest"
import { requiresPro, PRO_FEATURES } from "@/lib/pro-gates"

// RPC Pro feature-gate config. Locks the exact free-vs-Pro split so a future
// edit can't silently flip a free feature behind the paywall (or vice versa).

describe("requiresPro", () => {
  it("returns false for the free tier features", () => {
    expect(requiresPro("collection_basic")).toBe(false)
    expect(requiresPro("sniper_basic")).toBe(false)
    expect(requiresPro("badges_view")).toBe(false)
    expect(requiresPro("sets_view")).toBe(false)
    expect(requiresPro("concierge_basic")).toBe(false)
  })

  it("returns true for the Pro-only features", () => {
    expect(requiresPro("price_alerts")).toBe(true)
    expect(requiresPro("portfolio_export")).toBe(true)
    expect(requiresPro("cross_collection_deals")).toBe(true)
    expect(requiresPro("advanced_analytics")).toBe(true)
    expect(requiresPro("concierge_unlimited")).toBe(true)
    expect(requiresPro("weekly_digest")).toBe(true)
    expect(requiresPro("portfolio_pnl")).toBe(true)
  })

  it("requiresPro reads straight through to the config map", () => {
    for (const key of Object.keys(PRO_FEATURES) as (keyof typeof PRO_FEATURES)[]) {
      expect(requiresPro(key)).toBe(PRO_FEATURES[key])
    }
  })
})
