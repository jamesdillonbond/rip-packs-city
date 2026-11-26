import { describe, expect, it } from "vitest"
import { buildWeeklyPaniniBlock, paniniWeekFrom, withPanini } from "@/lib/emails/weekly-panini"

const r = (username: string, day: string, cards: number, fmv: number | null) => ({ username, day, cards, fmv_usd: fmv })

describe("paniniWeekFrom", () => {
  it("like-for-like prior: every username, same newest day, same card count", () => {
    expect(paniniWeekFrom(["a", "b"], [r("a", "2026-11-25", 10, 100), r("a", "2026-11-18", 10, 90), r("b", "2026-11-25", 2, 20), r("b", "2026-11-18", 2, 25)]))
      .toEqual({ usd: 120, cards: 12, priorUsd: 115 })
  })
  it("a week with cards bought or sold has no prior — not a price move", () => {
    expect(paniniWeekFrom(["a"], [r("a", "2026-11-25", 11, 100), r("a", "2026-11-18", 10, 90)])?.priorUsd).toBeNull()
  })
  it("no linked username, or no priced cards: no part at all — never $0", () => {
    expect(paniniWeekFrom([], [])).toBeNull()
    expect(paniniWeekFrom(["a"], [r("a", "2026-11-25", 4, null)])).toBeNull()
    expect(paniniWeekFrom(["a"], [])).toBeNull()
  })
})

describe("withPanini", () => {
  const h = { valueUsd: 1000, deltaUsd: 100, deltaPct: 11.11, scope: "all" as const }
  it("folds value and change in when the prior is like-for-like", () => {
    expect(withPanini(h, { usd: 120, cards: 12, priorUsd: 100 })).toEqual({ valueUsd: 1120, deltaUsd: 120, deltaPct: 12, scope: "all" })
  })
  it("without a prior the value grows and the change says it covers moments and packs", () => {
    expect(withPanini(h, { usd: 120, cards: 12, priorUsd: null })).toEqual({ ...h, valueUsd: 1120, scope: "no_cards" })
    expect(withPanini({ ...h, scope: "moments" }, { usd: 120, cards: 12, priorUsd: 100 }).scope).toBe("moments")
    expect(withPanini(h, null)).toBe(h)
  })
  it("the block says the cards are inside the headline", () => {
    expect(buildWeeklyPaniniBlock({ usd: 120, cards: 12, priorUsd: null }).html).toMatch(/Panini cards · included above/)
    expect(buildWeeklyPaniniBlock(null)).toEqual({ html: "", text: [] })
  })
})
