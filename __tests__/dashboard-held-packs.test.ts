import { describe, expect, it } from "vitest"
import { heldPacksCaption, sumHeldPacks, walletTotalUsd, walletTotalCaption } from "@/lib/dashboard/held-packs"

const fmt = (n: number) => "$" + n.toFixed(2)

describe("sumHeldPacks", () => {
  it("adds held, listed and low ask across wallets and counts failed reads", () => {
    const t = sumHeldPacks([
      { count: 327, listed_count: 273, floor_ask_usd: 30961.2 },
      { count: 28, listed_count: 28, floor_ask_usd: "922.99" },
      null,
      { count: 0, listed_count: 0, floor_ask_usd: 0 },
    ])
    expect(t).toEqual({ held: 355, listed: 301, lowAskUsd: 31884.19, unpriced: 0, walletsFailed: 1 })
  })
  it("v3: reads the CAPPED asks, never the raw floor (a $1M troll ask on a never-sold pack)", () => {
    const t = sumHeldPacks([
      { count: 2155, listed_count: 1915, floor_ask_usd: 1142835.82, capped_ask_count: 1541, capped_ask_usd: 27966.94, unreferenced_ask_count: 374 },
    ])
    expect(t).toEqual({ held: 2155, listed: 1541, lowAskUsd: 27966.94, unpriced: 374, walletsFailed: 0 })
  })
})

describe("heldPacksCaption", () => {
  it("says nothing when no sealed packs are held", () => {
    expect(heldPacksCaption({ held: 0, listed: 0, lowAskUsd: 0, walletsFailed: 0 }, false, fmt)).toBeNull()
    expect(heldPacksCaption(null, false, fmt)).toBeNull()
  })
  it("never renders a $0 pack total for a failed read", () => {
    expect(heldPacksCaption(null, true, fmt)).toBe("Sealed packs: couldn't load")
    expect(heldPacksCaption({ held: 0, listed: 0, lowAskUsd: 0, walletsFailed: 2 }, false, fmt)).toBe("Sealed packs: couldn't load")
  })
  it("shows the low ask total and how many packs are priced", () => {
    expect(heldPacksCaption({ held: 327, listed: 273, lowAskUsd: 30961.2, walletsFailed: 0 }, false, fmt))
      .toBe("+ $30961.20 in 327 sealed packs at low ask, 273 priced")
    expect(heldPacksCaption({ held: 1, listed: 1, lowAskUsd: 2.39, walletsFailed: 0 }, false, fmt))
      .toBe("+ $2.39 in 1 sealed pack at low ask")
  })
  it("names the listed packs it could not price", () => {
    expect(heldPacksCaption({ held: 2155, listed: 1541, lowAskUsd: 27966.94, unpriced: 374, walletsFailed: 0 }, false, fmt))
      .toBe("+ $27966.94 in 2,155 sealed packs at low ask, 1,541 priced, 374 listed with no sale to price them")
  })
  it("marks a partial total", () => {
    expect(heldPacksCaption({ held: 5, listed: 5, lowAskUsd: 10, walletsFailed: 1 }, false, fmt))
      .toBe("+ $10.00 in 5 sealed packs at low ask (some wallets didn't load)")
  })
  it("says so when no held pack has a priced ask", () => {
    expect(heldPacksCaption({ held: 3, listed: 0, lowAskUsd: 0, walletsFailed: 0 }, false, fmt)).toBe("3 sealed packs · no priced asks")
    expect(heldPacksCaption({ held: 1, listed: 0, lowAskUsd: 0, unpriced: 1, walletsFailed: 0 }, false, fmt))
      .toBe("1 sealed pack · no priced asks, 1 listed with no sale to price it")
  })
})

describe("walletTotalUsd / walletTotalCaption (2026-11-22 single number)", () => {
  const packs = { held: 488, listed: 487, lowAskUsd: 16429, walletsFailed: 0 }
  it("sums moments, stale moments and sealed packs into one figure", () => {
    expect(walletTotalUsd(43819, 5832, packs, false)).toBe(66080)
  })
  it("leaves packs out only when their read failed, and says so", () => {
    expect(walletTotalUsd(43819, 5832, packs, true)).toBe(49651)
    expect(walletTotalCaption(packs, true)).toMatch(/not included/)
    expect(walletTotalCaption(packs, false)).toBeNull()
  })
  it("says the figure is still adding packs while their read is in flight", () => {
    expect(walletTotalCaption(null, false, true)).toMatch(/Adding sealed packs/)
    expect(walletTotalCaption(packs, false, true)).toBeNull()
    expect(walletTotalCaption(null, false, false)).toBeNull()
  })
  it("handles no packs", () => {
    expect(walletTotalUsd(100, 0, null, false)).toBe(100)
  })
})

describe("sumOpenMarketFmv (2026-11-22 single number, closed markets out)", () => {
  it("adds fresh + stale FMV on open markets and leaves the closed UFC (Flow) market out", async () => {
    const { sumOpenMarketFmv, isClosedMarketCollectionId } = await import("@/lib/dashboard/aggregate")
    const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
    const UFC = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
    expect(isClosedMarketCollectionId(UFC)).toBe(true)
    expect(isClosedMarketCollectionId(TS)).toBe(false)
    expect(sumOpenMarketFmv({
      "0xabc": [
        { collection_id: TS, fmv_total: 40942.12, fmv_stale_total: 5049.5 },
        { collection_id: UFC, fmv_total: 0, fmv_stale_total: 364.26 },
      ],
    })).toBeCloseTo(45991.62, 2)
  })
})
