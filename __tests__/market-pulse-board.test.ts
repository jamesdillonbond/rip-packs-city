import { describe, it, expect } from "vitest"
import { fetchMarketPulse } from "@/lib/market-pulse-board"

// The public Market Pulse board. fetchMarketPulse wraps the get_market_pulse_windows
// SECDEF RPC: it throws on error and coerces non-array data to []. The client is a
// typed-any arg, so its rpc seam is trivially fakeable.
const sb = (data: any, error: any = null) => ({ rpc: async () => ({ data, error }) })

describe("fetchMarketPulse", () => {
  it("throws when the RPC returns an error", async () => {
    await expect(fetchMarketPulse(sb(null, { message: "pulse boom" }))).rejects.toThrow("pulse boom")
  })

  it("returns [] for null / non-array data", async () => {
    expect(await fetchMarketPulse(sb(null))).toEqual([])
    expect(await fetchMarketPulse(sb({ not: "an array" }))).toEqual([])
  })

  it("passes through an array of rows unchanged", async () => {
    const rows = [
      { slug: "nba-top-shot", collection_name: "NBA Top Shot", sales_24h: 10, volume_24h: 500 },
    ]
    expect(await fetchMarketPulse(sb(rows))).toBe(rows)
  })
})
