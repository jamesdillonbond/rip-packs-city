import { describe, expect, it } from "vitest"
import { heldPacksCaption, sumHeldPacks } from "@/lib/dashboard/held-packs"

const fmt = (n: number) => "$" + n.toFixed(2)

describe("sumHeldPacks", () => {
  it("adds held, listed and low ask across wallets and counts failed reads", () => {
    const t = sumHeldPacks([
      { count: 327, listed_count: 273, floor_ask_usd: 30961.2 },
      { count: 28, listed_count: 28, floor_ask_usd: "922.99" },
      null,
      { count: 0, listed_count: 0, floor_ask_usd: 0 },
    ])
    expect(t).toEqual({ held: 355, listed: 301, lowAskUsd: 31884.19, walletsFailed: 1 })
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
  it("shows the low ask total and how many packs are listed", () => {
    expect(heldPacksCaption({ held: 327, listed: 273, lowAskUsd: 30961.2, walletsFailed: 0 }, false, fmt))
      .toBe("+ $30961.20 in 327 sealed packs at low ask, 273 listed")
    expect(heldPacksCaption({ held: 1, listed: 1, lowAskUsd: 2.39, walletsFailed: 0 }, false, fmt))
      .toBe("+ $2.39 in 1 sealed pack at low ask")
  })
  it("marks a partial total", () => {
    expect(heldPacksCaption({ held: 5, listed: 5, lowAskUsd: 10, walletsFailed: 1 }, false, fmt))
      .toBe("+ $10.00 in 5 sealed packs at low ask (some wallets didn't load)")
  })
  it("says so when no held pack has a live ask", () => {
    expect(heldPacksCaption({ held: 3, listed: 0, lowAskUsd: 0, walletsFailed: 0 }, false, fmt)).toBe("3 sealed packs · no live asks")
  })
})
